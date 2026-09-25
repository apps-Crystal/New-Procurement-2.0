/**
 * Send whatever is queued in the notification outbox.
 *
 *   npm run drain:outbox            one pass
 *   npm run drain:outbox -- --watch keep going, every 30 seconds
 *
 * Deliberately a separate process. A user waiting on an SMTP handshake is a
 * user waiting on somebody else's infrastructure, and a mail server that is
 * down must never hold up a goods receipt.
 *
 * In production this is a cron entry or a sidecar. On a localhost box it is run
 * by hand, and `MAIL_TRANSPORT=log` prints what would have been sent.
 */
import { drainOutbox, outboxSummary } from '../lib/notify';
import { sql } from '../lib/db';

const WATCH_SECONDS = 30;

function summarise(rows: Awaited<ReturnType<typeof outboxSummary>>): string {
  if (rows.length === 0) return 'the outbox is empty';
  return rows.map(r => `${r.n} ${String(r.status).toLowerCase()}`).join(', ');
}

async function once(): Promise<number> {
  const before = await outboxSummary();
  const result = await drainOutbox();

  if (result.sent + result.failed + result.dead === 0) {
    console.log(`  nothing to send — ${summarise(before)}`);
    return 0;
  }

  console.log(
    `  sent ${result.sent}` +
      (result.failed ? `, ${result.failed} failed and will be retried` : '') +
      (result.dead ? `, ${result.dead} gave up after 5 attempts` : ''),
  );

  return result.sent + result.failed + result.dead;
}

async function main() {
  const watch = process.argv.includes('--watch');
  const transport = process.env.MAIL_TRANSPORT ?? 'log';

  console.log(`\nCrystal Procurement 2.0 — notification outbox (transport: ${transport})\n`);

  if (!watch) {
    await once();
    console.log('');
    await sql.end({ timeout: 5 });
    return;
  }

  console.log(`  watching, every ${WATCH_SECONDS}s. Ctrl-C to stop.\n`);

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    console.log('\n  stopping after this pass …');
  });

  while (!stopping) {
    try {
      await once();
    } catch (e) {
      // A drain that crashes stops every notification for everybody, so a bad
      // pass is reported and the loop carries on.
      console.error('  pass failed:', e instanceof Error ? e.message : e);
    }

    if (stopping) break;
    await new Promise(r => setTimeout(r, WATCH_SECONDS * 1000));
  }

  await sql.end({ timeout: 5 });
  console.log('  stopped\n');
}

void main().catch(async err => {
  console.error('\n  The outbox drain could not start:', err instanceof Error ? err.message : err, '\n');
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
