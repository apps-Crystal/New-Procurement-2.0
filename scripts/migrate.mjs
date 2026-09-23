/**
 * Migration runner.
 *
 * Applies db/migrations/*.sql in filename order, once each, recording what ran
 * in schema_migrations. Each file carries its own BEGIN/COMMIT, so a failing
 * migration leaves the database exactly as it was.
 *
 * Prefers DIRECT_URL over DATABASE_URL. On a local server the two are the same;
 * on a hosted database that puts a transaction pooler in front, DDL has to go
 * to the direct port.
 *
 * An applied migration is immutable — editing one that has already run is
 * refused, because the file and the database have diverged and re-running
 * cannot reconcile them. Add a new migration instead.
 *
 *   npm run migrate               apply pending migrations
 *   npm run migrate -- --status   list what has and has not run
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const args = process.argv.slice(2);
const STATUS_ONLY = args.includes('--status');

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_URL (or DATABASE_URL) is not set. Copy .env.example to .env.local and fill it in.');
  process.exit(1);
}
if (!process.env.DIRECT_URL) {
  console.warn('! DIRECT_URL is not set — using DATABASE_URL.');
  console.warn('  That is fine locally. Against a pooled hosted database, set DIRECT_URL to the direct port.');
}

// A local server does not speak TLS; a hosted one generally requires it.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

const sql = postgres(url, {
  ssl: isLocal ? false : 'require',
  prepare: false,
  max: 1,
  connect_timeout: 30,
  idle_timeout: 20,
  connection: { application_name: 'crystal-procurement-2-migrate' },
});

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`;

  const applied = new Map(
    (await sql`SELECT filename, checksum FROM schema_migrations`).map(r => [r.filename, r.checksum]),
  );

  const files = (await readdir(DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (STATUS_ONLY) {
    for (const f of files) {
      const was = applied.get(f);
      const body = await readFile(path.join(DIR, f), 'utf8');
      const now = sha(body);
      const mark = !was ? 'pending' : was === now ? 'applied' : 'APPLIED BUT CHANGED SINCE';
      console.log(`  ${was === now ? '✓' : ' '} ${f.padEnd(34)} ${mark}`);
    }
    return;
  }

  let ran = 0;
  for (const filename of files) {
    const body = await readFile(path.join(DIR, filename), 'utf8');
    const checksum = sha(body);
    const previous = applied.get(filename);

    if (previous) {
      if (previous !== checksum) {
        // A migration that has already run must never be edited: the database
        // and the file have diverged and no amount of re-running fixes it.
        console.error(`\n✗ ${filename} has changed since it was applied.`);
        console.error('  Applied migrations are immutable. Add a new migration instead.');
        process.exitCode = 1;
        return;
      }
      continue;
    }

    process.stdout.write(`  applying ${filename} … `);
    try {
      // Each file carries its own BEGIN/COMMIT, so run it as one statement
      // batch rather than wrapping it again.
      await sql.unsafe(body);
      await sql`INSERT INTO schema_migrations (filename, checksum) VALUES (${filename}, ${checksum})`;
      console.log('ok');
      ran++;
    } catch (err) {
      console.log('failed');
      console.error(`\n✗ ${filename}: ${err.message}`);
      if (err.hint) console.error(`  hint: ${err.hint}`);
      if (err.position) console.error(`  at character ${err.position}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(ran === 0 ? '\nNothing to apply — the database is up to date.' : `\nApplied ${ran} migration(s).`);
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
