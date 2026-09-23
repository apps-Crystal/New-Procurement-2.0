/**
 * Mint a session cookie for local development.
 *
 *   npm run dev:session -- apps@crystalgroup.in
 *
 * Sessions are normally minted only by /sso, after Crystal Core has verified a
 * launch token. That is the right rule, and it makes local work on a screen
 * impossible without a round trip through Core. This signs a cookie with the
 * same HMAC so a developer can load a page directly.
 *
 * It is NOT a back door: the cookie is signed with SESSION_SECRET, which only
 * the deployment holds, and it grants nothing on its own — roles still come
 * from `user_site_roles` on every request. A user with no grant still lands on
 * /no-access.
 *
 * Never run this against a production SESSION_SECRET.
 */
import { signSession } from '../lib/auth/session';
import { sql } from '../lib/db';

const email = process.argv[2]?.trim().toLowerCase();

if (!email || !email.includes('@')) {
  console.error('\nUsage: npm run dev:session -- someone@crystalgroup.in\n');
  process.exit(1);
}

async function main() {
  const [user] = await sql<{ core_user_id: string; full_name: string }[]>`
    SELECT core_user_id, full_name FROM app_users WHERE email = ${email}`;

  if (!user) {
    console.error(`\n  No app_users row for ${email}.`);
    console.error('  Run: npm run bootstrap:admin -- ' + email + '\n');
    process.exit(1);
  }

  const cookie = await signSession({
    email,
    name: user.full_name,
    role: '',
    userId: user.core_user_id,
  });

  console.log('\nDevelopment session for ' + email + '\n');
  console.log('  Cookie:');
  console.log(`    crystal_proc2_session=${cookie}\n`);
  console.log('  Load a page with curl:');
  console.log(`    curl -s -H "Cookie: crystal_proc2_session=${cookie}" http://localhost:3000/vendors\n`);
  console.log('  Or in the browser console on http://localhost:3000 :');
  console.log(`    document.cookie = "crystal_proc2_session=${cookie}; path=/"\n`);
}

main().catch(err => {
  console.error(`\n  Failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
