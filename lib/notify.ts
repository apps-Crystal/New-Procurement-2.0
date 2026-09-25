/**
 * Notification outbox (brief §30).
 *
 * The schema's own comment says why this is a table rather than an email call:
 *
 *   -- Outbox: a failed send never blocks the transaction
 *
 * So `enqueue()` writes a row inside the caller's transaction and returns. If
 * the transaction rolls back the notification goes with it, which is the point
 * — nobody should be told a purchase request was approved when it was not. And
 * if the mail server is down, the business carries on.
 *
 * Sending is a separate process (`npm run drain:outbox`). It is deliberately
 * not triggered from a request: a user waiting on an SMTP handshake is a user
 * waiting on somebody else's infrastructure.
 *
 * On actually sending mail: there is no SMTP server on a localhost box, and
 * inventing one would make this untestable. The transport is chosen by
 * `MAIL_TRANSPORT` — `log` (the default) writes what would have been sent,
 * `noop` drops it. A real transport is a small addition at the marked point,
 * and everything around it — retry, backoff, dead-lettering — is already here
 * and tested.
 */
import { sql, type Tx } from '@/lib/db';
import type { Row } from '@/lib/services/masters';

/** Attempts before a message is given up on and marked DEAD. */
export const MAX_ATTEMPTS = 5;

export interface NotifyInput {
  eventKey: string;
  entityType: string;
  entityId: number;
  /** Everything the message needs. Rendered by the drain, not here. */
  payload: Record<string, unknown>;
}

/**
 * Queue a notification.
 *
 * Runs inside the caller's transaction. A disabled event writes nothing — the
 * configuration is consulted at enqueue rather than at send, so turning an
 * event off stops it being recorded at all rather than leaving a queue of
 * messages nobody will ever receive.
 *
 * Never throws for a business reason. A notification that cannot be queued
 * must not roll back the thing it was describing, so an unknown event key is
 * logged and swallowed rather than raised. The foreign key to `email_config`
 * would otherwise abort the whole transaction over an email.
 */
export async function enqueue(tx: Tx, input: NotifyInput): Promise<number | null> {
  try {
    const [config] = await tx<Row[]>`
      SELECT is_enabled FROM email_config WHERE event_key = ${input.eventKey}`;

    if (!config) {
      console.error(`[notify] unknown event key "${input.eventKey}" — nothing queued`);
      return null;
    }
    if (config.is_enabled !== true) return null;

    const [row] = await tx<Row[]>`
      INSERT INTO notification_outbox (event_key, entity_type, entity_id, payload, status)
      VALUES (${input.eventKey}, ${input.entityType}, ${input.entityId},
              ${tx.json(input.payload as never)}, 'QUEUED')
      RETURNING id`;

    return Number(row.id);
  } catch (e) {
    // Deliberately swallowed. See the note above: an email must never undo a
    // goods receipt.
    console.error('[notify] could not queue a notification:', e);
    return null;
  }
}

// =============================================================================
// Sending
// =============================================================================

export interface Message {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export type Transport = (message: Message) => Promise<void>;

/**
 * Where a message actually goes.
 *
 * `log` prints it, which is what a localhost run wants and what makes the
 * retry machinery testable. A real SMTP or provider transport slots in here
 * without touching anything else in this file.
 */
function transport(): Transport {
  const mode = process.env.MAIL_TRANSPORT ?? 'log';

  if (mode === 'noop') {
    return async () => {};
  }

  if (mode === 'fail') {
    // Used by the verification to prove retry, backoff and dead-lettering.
    return async () => {
      throw new Error('The mail transport is configured to fail.');
    };
  }

  return async message => {
    console.log(
      `[mail] to=${message.to.join(',') || '(nobody)'}` +
        `${message.cc.length ? ` cc=${message.cc.join(',')}` : ''}` +
        `\n      ${message.subject}\n      ${message.body.replace(/\n/g, '\n      ')}`,
    );
  };
}

/**
 * Turn a queued row into a message.
 *
 * The subject is the event and the record; the body is the payload, laid out
 * plainly. There is no template engine, because there are forty-nine events
 * and a template per event would be forty-nine files nobody keeps current —
 * the payload each service already builds is more accurate than a template
 * would stay.
 */
export function render(row: Row, recipients: { to: string[]; cc: string[]; bcc: string[] }): Message {
  const event = String(row.event_key).replace(/_/g, ' ').toLowerCase();
  const payload = (row.payload ?? {}) as Record<string, unknown>;

  const reference = String(payload.reference ?? `${row.entity_type} ${row.entity_id}`);

  const lines = Object.entries(payload)
    .filter(([k]) => k !== 'reference')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`);

  return {
    ...recipients,
    subject: `Crystal — ${event}: ${reference}`,
    body: [`${reference} — ${event}.`, '', ...lines].join('\n'),
  };
}

export interface DrainResult {
  sent: number;
  failed: number;
  dead: number;
}

/**
 * Send what is queued.
 *
 * Each message is its own transaction: one bad address must not hold up the
 * rest of the queue. A failure increments `attempts` and goes back to FAILED,
 * which the partial index still picks up, until `MAX_ATTEMPTS` — after which
 * it is DEAD and stops being retried forever.
 *
 * Backoff is by age rather than by a timer: a row is only retried once it is
 * older than `attempts` minutes. That is crude, and crude is right here —
 * anything cleverer needs state this table does not carry.
 */
export async function drainOutbox(limit = 50): Promise<DrainResult> {
  const send = transport();
  const result: DrainResult = { sent: 0, failed: 0, dead: 0 };

  const queued = await sql<Row[]>`
    SELECT o.*, c.fixed_to, c.cc, c.bcc
      FROM notification_outbox o
      JOIN email_config c ON c.event_key = o.event_key
     WHERE o.status IN ('QUEUED', 'FAILED')
       AND c.is_enabled
       -- Crude backoff: wait one minute per attempt already made.
       AND o.created_at < now() - (o.attempts * interval '1 minute')
     ORDER BY o.created_at
     LIMIT ${limit}`;

  for (const row of queued) {
    const recipients = {
      to: (row.fixed_to as string[]) ?? [],
      cc: (row.cc as string[]) ?? [],
      bcc: (row.bcc as string[]) ?? [],
    };

    try {
      await send(render(row, recipients));

      await sql`
        UPDATE notification_outbox
           SET status = 'SENT', sent_at = now(), attempts = attempts + 1, last_error = NULL
         WHERE id = ${row.id as number}`;
      result.sent++;
    } catch (e) {
      const attempts = Number(row.attempts) + 1;
      const dead = attempts >= MAX_ATTEMPTS;

      await sql`
        UPDATE notification_outbox
           SET status = ${dead ? 'DEAD' : 'FAILED'},
               attempts = ${attempts},
               last_error = ${e instanceof Error ? e.message : String(e)}
         WHERE id = ${row.id as number}`;

      if (dead) result.dead++;
      else result.failed++;
    }
  }

  return result;
}

/** What is sitting in the queue, for the administration screen. */
export async function outboxSummary(): Promise<Row[]> {
  return sql<Row[]>`
    SELECT status, count(*)::int AS n, max(created_at) AS newest
      FROM notification_outbox
     GROUP BY status
     ORDER BY status`;
}
