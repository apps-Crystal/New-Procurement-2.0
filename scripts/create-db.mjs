/**
 * Create the application database.
 *
 *   npm run db:create
 *
 * Connects to the `postgres` maintenance database using ADMIN_URL and creates
 * whatever database DATABASE_URL points at. Separate from the migration runner
 * because CREATE DATABASE cannot run inside a transaction, and because pointing
 * a migration at a database that does not exist yet gives a confusing error.
 *
 * Safe to re-run: says so and stops if the database is already there.
 */
import postgres from 'postgres';

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;

if (!adminUrl || !appUrl) {
  console.error('\nSet ADMIN_URL and DATABASE_URL in .env.local.\n');
  process.exit(1);
}

if (adminUrl.includes('<PASSWORD>') || appUrl.includes('<PASSWORD>')) {
  console.error('\n  .env.local still contains the <PASSWORD> placeholder.');
  console.error('  Replace it with the password for the postgres user, URL-encoding');
  console.error('  any special characters (@ is %40, # is %23, / is %2F).\n');
  process.exit(1);
}

const dbName = decodeURIComponent(new URL(appUrl).pathname.replace(/^\//, ''));
if (!dbName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
  console.error(`\n  "${dbName}" is not a usable database name.\n`);
  process.exit(1);
}

const admin = postgres(adminUrl, { ssl: false, max: 1, connect_timeout: 15, onnotice: () => {} });

try {
  console.log(`\nCrystal Procurement 2.0 — create database\n`);

  const [existing] = await admin`SELECT 1 AS found FROM pg_database WHERE datname = ${dbName}`;

  if (existing) {
    console.log(`  Database "${dbName}" already exists — nothing to do.\n`);
  } else {
    // Identifier, not a value, so it cannot be parameterised.
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    console.log(`  Created database "${dbName}".\n`);
  }

  console.log('  Next: npm run migrate\n');
} catch (err) {
  const message = err?.message ?? String(err);
  console.error(`\n  Failed: ${message}`);
  if (/password authentication failed/i.test(message)) {
    console.error('  The password in ADMIN_URL is wrong.\n');
  } else if (/ECONNREFUSED/i.test(message)) {
    console.error('  Nothing is listening. Is the PostgreSQL service running?\n');
  } else {
    console.error('');
  }
  process.exitCode = 1;
} finally {
  await admin.end({ timeout: 5 });
}
