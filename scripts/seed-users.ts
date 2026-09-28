/**
 * One user per role, so segregation of duties can actually be exercised.
 *
 *   npm run seed:users
 *   npm run seed:users -- --site DEV
 *
 * A single account holding every role cannot test this system. Nearly every
 * control here is "somebody else must do the next step" — you cannot approve a
 * vendor you created, approve a PR you raised, inspect goods you received, or
 * approve bank details you proposed. With one user those paths are unreachable,
 * and the only thing you can prove is that they refuse.
 *
 * So: ten users, one role each, named after the job. Switch between them with
 * "Switch user" in the sidebar (local sign-in, development only).
 *
 * Roles are granted through the normal service, so every grant is permission
 * checked and audited. Safe to re-run: anyone already present keeps what they
 * have, and nothing is overwritten.
 *
 * DEVELOPMENT ONLY. These are local accounts with no password — see
 * lib/auth/mode.ts for why that is acceptable on localhost and refused
 * anywhere else. When Crystal Core is switched on, /sso matches on email and
 * re-points each row, keeping its history.
 */
import { sql } from '../lib/db';
import { grantRole } from '../lib/services/masters';
import { localSubjectId, localAuthAvailable } from '../lib/auth/mode';
import type { Principal, RoleCode } from '../lib/auth/permissions';

/** One per role, named after the job rather than after a person. */
const PEOPLE: { email: string; name: string; role: RoleCode; does: string }[] = [
  { email: 'requester@crystalgroup.in', name: 'Requester', role: 'CG_REQ', does: 'raises material requests' },
  { email: 'site.manager@crystalgroup.in', name: 'Site Manager', role: 'CG_SMGR', does: 'stock-checks and declares them' },
  { email: 'buyer@crystalgroup.in', name: 'Buyer', role: 'CG_BUY', does: 'purchase requests, vendors, quotations, orders' },
  { email: 'receiver@crystalgroup.in', name: 'Site Receiver', role: 'CG_RCV', does: 'logs goods in at the gate' },
  { email: 'qc@crystalgroup.in', name: 'QA/QC Inspector', role: 'CG_QC', does: 'inspects what arrived' },
  { email: 'warehouse@crystalgroup.in', name: 'Warehouse Lead', role: 'CG_WHL', does: 'goods receipt, issues, locations' },
  { email: 'accounts@crystalgroup.in', name: 'Accounts', role: 'CG_ACC', does: 'invoices, debit notes, reconciliation' },
  { email: 'finance.head@crystalgroup.in', name: 'Functional Head', role: 'CG_FHEAD', does: 'approves vendors, bank details, value bands' },
  { email: 'director@crystalgroup.in', name: 'Director', role: 'CG_DIR', does: 'the top approval band, group-wide' },
  { email: 'admin@crystalgroup.in', name: 'Administrator', role: 'CG_ADM', does: 'master data, users and roles' },
];

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  console.log('\nCrystal Procurement 2.0 — one user per role\n');

  if (!localAuthAvailable()) {
    console.error('  Local sign-in is off, so these accounts could never be used. Stopping.\n');
    process.exit(1);
  }

  // ---- The site to grant at --------------------------------------------------
  const wanted = flag('site');
  const sites = await sql<{ id: string; code: string; status: string }[]>`
    SELECT id, code, status FROM sites ORDER BY id`;

  if (sites.length === 0) {
    console.error('  No sites. Run bootstrap:admin with --site first.\n');
    process.exit(1);
  }

  const site = wanted
    ? sites.find(s => s.code.toUpperCase() === wanted.toUpperCase())
    : sites.find(s => s.status === 'ACTIVE') ?? sites[0];

  if (!site) {
    console.error(`  No site ${wanted}. Have: ${sites.map(s => s.code).join(', ')}\n`);
    process.exit(1);
  }

  const siteId = Number(site.id);
  console.log(`  Site ${site.code}\n`);

  // ---- Who is granting -------------------------------------------------------
  // Granting needs MASTER.USER_ROLE_MANAGE, which is CG_ADM. Borrow an existing
  // administrator rather than inventing authority: if nobody is an admin yet,
  // that is bootstrap:admin's job, not this script's.
  const [admin] = await sql<{ id: string; email: string; full_name: string }[]>`
    SELECT u.id, u.email, u.full_name
      FROM app_users u
      JOIN user_site_roles r ON r.user_id = u.id AND r.role = 'CG_ADM'
     ORDER BY u.id LIMIT 1`;

  if (!admin) {
    console.error('  Nobody holds CG_ADM, so no role can be granted.');
    console.error('  Run:  npm run bootstrap:admin -- you@crystalgroup.in\n');
    process.exit(1);
  }

  const principal: Principal = {
    userId: Number(admin.id),
    coreUserId: `seed:${admin.email}`,
    email: admin.email,
    fullName: admin.full_name ?? admin.email,
    sites: [],
    roles: ['CG_ADM'],
    groupWide: true,
  };
  const actor = { principal, ip: null };
  console.log(`  Granting as ${admin.email}\n`);

  // ---- The people ------------------------------------------------------------
  for (const p of PEOPLE) {
    const email = p.email.toLowerCase();

    let [user] = await sql<{ id: string }[]>`SELECT id FROM app_users WHERE lower(email) = ${email}`;
    let note = '';

    if (!user) {
      const [created] = await sql<{ id: string }[]>`
        INSERT INTO app_users (core_user_id, email, full_name)
        VALUES (${localSubjectId(email)}, ${email}, ${p.name})
        RETURNING id`;
      user = created;
      note = 'created';
    }

    const [held] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM user_site_roles
       WHERE user_id = ${Number(user.id)} AND site_id = ${siteId} AND role = ${p.role}::role_code`;

    if (Number(held.n) === 0) {
      await grantRole(actor, { userId: Number(user.id), siteId, role: p.role });
      note = note ? `${note}, ${p.role} granted` : `${p.role} granted`;
    } else if (!note) {
      note = 'already set up';
    }

    console.log(`  ${p.name.padEnd(18)} ${p.email.padEnd(32)} ${p.role.padEnd(9)} ${note}`);
  }

  console.log(`
  Ten accounts, one role each. Switch between them with "Switch user" in the
  sidebar, or at /signin.

  What this makes testable -- each of these refuses when one person tries both:

    vendor      Buyer creates it            -> Functional Head approves
    bank        Buyer or Accounts proposes  -> Functional Head approves
    material    Requester raises            -> Site Manager declares
    purchase    Buyer raises the PR         -> Functional Head / Director approve
    receiving   Site Receiver logs it in    -> QA/QC inspects  -> Warehouse Lead receipts

  apps@crystalgroup.in keeps the roles it already had. It is the account that
  can do everything, which is exactly why it cannot second-check itself.
`);

  await sql.end({ timeout: 5 });
}

void main().catch(async err => {
  console.error('\n  Could not seed users:', err instanceof Error ? err.message : err, '\n');
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
