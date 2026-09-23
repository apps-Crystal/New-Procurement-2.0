/**
 * Audit trail (brief §29).
 *
 * `audit_log` is append-only, enforced by the `forbid_mutation()` trigger — not
 * by convention. Every write here happens INSIDE the caller's transaction, so
 * an audit row can never survive an operation that rolled back, and an
 * operation can never commit without its audit row.
 *
 * Who, what, when, old state, new state, remarks, and the document.
 */
import type { Tx } from '@/lib/db';

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'TRANSITION'
  | 'OVERRIDE'
  | 'PERMISSION_CHANGE'
  | 'REJECTED_ATTEMPT'
  | 'DELETE';

export interface AuditEntry {
  entityType: string;
  entityId: number;
  action: AuditAction;
  fromStatus?: string | null;
  toStatus?: string | null;
  before?: unknown;
  after?: unknown;
  userId: number | null;
  ip?: string | null;
  remarks?: string | null;
}

/**
 * Fields never written into the audit trail, at any depth.
 *
 * Encrypted bank details in particular: audit rows are widely readable, and
 * copying ciphertext into them widens the blast radius of a key compromise.
 */
const REDACTED_KEYS = new Set(['account_number_enc', 'account_number', 'session', 'password', 'token']);

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return '[binary]';
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Write one audit row inside the caller's transaction. */
export async function audit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx`
    INSERT INTO audit_log (entity_type, entity_id, action, from_status, to_status,
                           before_data, after_data, user_id, ip_address, remarks)
    VALUES (${entry.entityType},
            ${entry.entityId},
            ${entry.action},
            ${entry.fromStatus ?? null},
            ${entry.toStatus ?? null},
            ${entry.before === undefined ? null : tx.json(redact(entry.before) as never)},
            ${entry.after === undefined ? null : tx.json(redact(entry.after) as never)},
            ${entry.userId},
            ${entry.ip ?? null},
            ${entry.remarks ?? null})`;
}

/**
 * Record an attempt that was refused — a permission denial, a
 * segregation-of-duty block, an illegal transition.
 *
 * These are the rows an auditor actually asks for, so they are kept even though
 * nothing changed. Runs in its own transaction, because the one it describes
 * has already rolled back or was never opened.
 */
export async function auditRejectedAttempt(
  sqlClient: { begin: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> },
  entry: Omit<AuditEntry, 'action'> & { remarks: string },
): Promise<void> {
  try {
    await sqlClient.begin(async tx => {
      await audit(tx, { ...entry, action: 'REJECTED_ATTEMPT' });
    });
  } catch (err) {
    // Never let an audit failure mask the original refusal.
    console.error('[audit] failed to record rejected attempt:', err);
  }
}
