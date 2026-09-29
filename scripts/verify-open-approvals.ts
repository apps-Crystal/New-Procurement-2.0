/**
 * Does OPEN_APPROVALS do what it says, and ONLY that?
 *
 *   npm run verify:open-approvals
 *
 * Valid either way: with the flag set it proves the decision keys opened, and
 * with it unset it proves they closed again. Either way it proves the things
 * that must never open — acting at a site you hold nothing at, doing somebody
 * else's job rather than their decision, and approving your own work.
 */
import { sql } from '../lib/db';
import { can, openApprovals, PERMISSION_MATRIX } from '../lib/auth/permissions';
import type { Principal, RoleCode } from '../lib/auth/permissions';

function principal(userId: number, roles: RoleCode[], siteId: number): Principal {
  return {
    userId, coreUserId: 'check', email: 'check@crystalgroup.in', fullName: 'Check',
    sites: [{ siteId, siteCode: 'DEV', siteName: 'Dev Sandbox', roles }],
    roles, groupWide: roles.includes('CG_ADM') || roles.includes('CG_DIR'),
  };
}

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${note ? '  — ' + note : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${note ? '  — ' + note : ''}`); }
};

async function main() {
  console.log(`\n  OPEN_APPROVALS is ${openApprovals() ? 'ON' : 'off'}\n`);

  const SITE = 1;
  const requester = principal(1, ['CG_REQ'], SITE);
  const qc = principal(2, ['CG_QC'], SITE);
  const stranger = principal(3, [], 999);          // no grant at this site

  // --- what the switch opens -------------------------------------------------
  const open = openApprovals();
  const expected = open ? 'may' : 'may not';

  ok(`a Requester ${expected} approve a material request`,
     can(requester, 'MR.APPROVE', SITE) === open,
     'the matrix says CG_SMGR / CG_FHEAD / CG_DIR');

  ok(`a QA/QC inspector ${expected} approve a goods receipt`,
     can(qc, 'GRN.APPROVE', SITE) === open,
     'the matrix says CG_SMGR');

  ok(`a Requester ${expected} approve a vendor`,
     can(requester, 'VENDOR.APPROVE', SITE) === open);

  // --- what it must NOT open -------------------------------------------------
  ok('somebody with no grant at the site still cannot decide',
     !can(stranger, 'MR.APPROVE', SITE),
     'it opens which role, not whether a stranger may');

  ok('a Requester still cannot issue a purchase order',
     !can(requester, 'PO.ISSUE', SITE),
     'not a decision — untouched');

  ok('a QA/QC inspector still cannot create a vendor',
     !can(qc, 'VENDOR.CREATE', SITE));

  ok('a Requester still cannot manage users and roles',
     !can(requester, 'MASTER.USER_ROLE_MANAGE', SITE));

  // --- the matrix itself is untouched ---------------------------------------
  ok('PERMISSION_MATRIX still records the real duty split',
     JSON.stringify(PERMISSION_MATRIX['MR.APPROVE']) === JSON.stringify(['CG_SMGR', 'CG_FHEAD', 'CG_DIR']),
     `MR.APPROVE = ${JSON.stringify(PERMISSION_MATRIX['MR.APPROVE'])}`);

  // --- the database still refuses self-approval ------------------------------
  const [mr] = await sql<{ id: string; mr_no: string; requester_id: string }[]>`
    SELECT id, mr_no, requester_id FROM material_requests ORDER BY id LIMIT 1`;

  if (mr) {
    let refused = false;
    let message = '';
    try {
      await sql`UPDATE material_requests SET approved_by = ${Number(mr.requester_id)} WHERE id = ${Number(mr.id)}`;
      await sql`UPDATE material_requests SET approved_by = NULL WHERE id = ${Number(mr.id)}`; // undo if it got through
    } catch (e) {
      refused = true;
      message = (e as Error).message.split('\n')[0];
    }
    ok('the database still refuses a self-approval, flag or not', refused,
       refused ? message.slice(0, 90) : 'IT WENT THROUGH — the constraint is gone');
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await sql.end({ timeout: 3 });
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch(async e => {
  console.error('  ' + (e as Error).message);
  await sql.end({ timeout: 3 }).catch(() => {});
  process.exit(1);
});
