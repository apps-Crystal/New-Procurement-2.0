/**
 * Grant the first administrator, and the first site if there is none.
 *
 *   npm run bootstrap:admin -- admin@crystalgroup.in
 *   npm run bootstrap:admin -- admin@crystalgroup.in \
 *       --site DHU --name Dhulagarh --state 19 --gstin 19AABCU9603R1ZX --tally CC-DHU
 *
 * Solves a genuine chicken-and-egg problem. Granting a role needs
 * MASTER.USER_ROLE_MANAGE, which only CG_ADM holds; nothing in the application
 * grants CG_ADM. And a role is always granted AT a site, so an empty database
 * cannot produce its first administrator either. Without this, everyone who
 * signs in lands on /no-access forever.
 *
 * Deliberately a command-line tool rather than a screen: granting yourself
 * administrator should require access to the deployment, not a browser. The
 * site is created through the normal service, so every validation rule and
 * every constraint still applies — this is a bootstrap, not a back door.
 *
 * Safe to re-run.
 */
import { sql, inTransaction } from '../lib/db';
import { audit } from '../lib/audit';
import { createSite } from '../lib/services/masters';
import type { Principal, RoleCode } from '../lib/auth/permissions';
import { localSubjectId } from '../lib/auth/mode';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const email = process.argv[2]?.trim().toLowerCase();

if (!email || !email.includes('@') || email.startsWith('--')) {
  console.error('\nUsage: npm run bootstrap:admin -- admin@crystalgroup.in');
  console.error('       add --site CODE --name NAME --state NN --gstin GSTIN --tally REF');
  console.error('       when the database has no sites yet.\n');
  process.exit(1);
}

/**
 * The person running this IS the administrator being created, so the synthetic
 * principal is an accurate description of who is acting, not a bypass.
 */
function bootstrapPrincipal(userId: number): Principal {
  const roles: RoleCode[] = ['CG_ADM'];
  return {
    userId,
    coreUserId: `bootstrap:${email}`,
    email,
    fullName: email,
    sites: [],
    roles,
    groupWide: true,
  };
}

async function findOrCreateUser(): Promise<number> {
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM app_users WHERE email = ${email}`;
  if (existing) return Number(existing.id);

  console.log(`  No app_users row for ${email} — creating one.`);
  console.log('  The subject id is marked local for now. When Crystal Core is switched on,');
  console.log('  /sso matches on email and re-points this row, keeping all its history.\n');

  const [created] = await sql<{ id: string }[]>`
    INSERT INTO app_users (core_user_id, email, full_name)
    VALUES (${localSubjectId(email)}, ${email}, ${email})
    RETURNING id`;

  return Number(created.id);
}

async function ensureSite(userId: number): Promise<{ id: number; code: string }[]> {
  const sites = await sql<{ id: string; code: string; status: string }[]>`
    SELECT id, code, status FROM sites ORDER BY code`;

  if (sites.length > 0) {
    const active = sites.filter(s => s.status === 'ACTIVE');
    const targets = active.length > 0 ? active : sites;
    return targets.map(s => ({ id: Number(s.id), code: s.code }));
  }

  const code = flag('site');
  const name = flag('name');
  const state = flag('state');
  const gstin = flag('gstin');
  const tally = flag('tally');

  if (!code || !name || !state || !gstin) {
    console.error('  The database has no sites, and a role is always granted at a site.\n');
    console.error('  Re-run with the first site, for example:');
    console.error(`    npm run bootstrap:admin -- ${email} \\`);
    console.error('      --site DHU --name Dhulagarh --state 19 --gstin 19AABCU9603R1ZX --tally CC-DHU\n');
    console.error('  The GSTIN must begin with the state code, and a Tally cost centre is');
    console.error('  required to activate the site.\n');
    process.exit(1);
  }

  console.log(`  Creating the first site ${code}…`);

  const site = await createSite(
    { principal: bootstrapPrincipal(userId), ip: null },
    {
      code,
      name,
      siteType: flag('type') ?? 'WAREHOUSE',
      address: flag('address') ?? name,
      stateCode: state,
      gstin,
      tallyCostCentre: tally ?? null,
      status: tally ? 'ACTIVE' : 'INACTIVE',
    },
  );

  if (!tally) console.log('  No --tally given, so the site is INACTIVE until its cost centre is set.\n');

  return [{ id: Number(site.id), code: String(site.code) }];
}

async function main() {
  console.log('\nCrystal Procurement 2.0 — bootstrap administrator\n');

  const userId = await findOrCreateUser();
  const targets = await ensureSite(userId);

  console.log(`  Granting CG_ADM to ${email} (user ${userId}) at ${targets.length} site(s):`);

  const granted: string[] = [];

  await inTransaction(async tx => {
    for (const site of targets) {
      const result = await tx`
        INSERT INTO user_site_roles (user_id, site_id, role)
        VALUES (${userId}, ${site.id}, 'CG_ADM')
        ON CONFLICT (user_id, site_id, role) DO NOTHING`;

      const isNew = result.count > 0;
      console.log(`    ${site.code.padEnd(8)} ${isNew ? 'granted' : 'already held'}`);
      if (isNew) granted.push(site.code);
    }

    if (granted.length > 0) {
      await audit(tx, {
        entityType: 'USER_SITE_ROLE',
        entityId: userId,
        action: 'PERMISSION_CHANGE',
        after: { email, role: 'CG_ADM', sites: granted },
        // No signed-in actor: this runs from the command line, by whoever holds
        // access to the deployment. Recorded as that rather than attributed to
        // a user who did not perform it.
        userId: null,
        remarks: `Bootstrap administrator granted from the command line to ${email}`,
      });
    }
  });

  console.log(
    granted.length > 0
      ? `\n  Done. Start the app and sign in at http://localhost:3000/signin as ${email}.\n`
      : `\n  Nothing to do — ${email} already holds CG_ADM everywhere.\n`,
  );
}

main()
  .catch(err => {
    console.error(`\n  Failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
