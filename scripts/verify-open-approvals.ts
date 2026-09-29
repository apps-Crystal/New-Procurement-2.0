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
import { can, grantedKeys, openAccess, openApprovals, PERMISSION_MATRIX } from '../lib/auth/permissions';
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
  const decisions = openApprovals();
  const everything = openAccess();
  const level = everything ? 'OPEN_ACCESS (everything)' : decisions ? 'OPEN_APPROVALS (decisions only)' : 'off';
  console.log(`\n  Development access switch: ${level}\n`);

  const SITE = 1;
  const requester = principal(1, ['CG_REQ'], SITE);
  const qc = principal(2, ['CG_QC'], SITE);
  const stranger = principal(3, [], 999);          // no grant at this site

  // --- decisions: opened by either switch ------------------------------------
  const d = decisions ? 'may' : 'may not';

  ok(`a Requester ${d} approve a material request`,
     can(requester, 'MR.APPROVE', SITE) === decisions,
     'the matrix says CG_SMGR / CG_FHEAD / CG_DIR');

  ok(`a QA/QC inspector ${d} approve a goods receipt`,
     can(qc, 'GRN.APPROVE', SITE) === decisions,
     'the matrix says CG_SMGR');

  ok(`a Requester ${d} approve a vendor`,
     can(requester, 'VENDOR.APPROVE', SITE) === decisions);

  // --- non-decisions: opened only by OPEN_ACCESS -----------------------------
  const e = everything ? 'may' : 'may not';

  ok(`a Requester ${e} issue a purchase order`,
     can(requester, 'PO.ISSUE', SITE) === everything,
     'not a decision — OPEN_APPROVALS leaves it shut');

  ok(`a QA/QC inspector ${e} create a vendor`,
     can(qc, 'VENDOR.CREATE', SITE) === everything);

  ok(`a Requester ${e} manage users and roles`,
     can(requester, 'MASTER.USER_ROLE_MANAGE', SITE) === everything,
     everything ? 'OPEN_ACCESS grants this — anyone can re-role themselves' : 'the matrix says CG_ADM');

  // --- the site floor, which neither switch lifts -----------------------------
  ok('somebody with no grant at the site still cannot decide',
     !can(stranger, 'MR.APPROVE', SITE),
     'it opens which role may act, not whether a stranger may');

  ok('somebody with no grant at the site still cannot do anything else either',
     !can(stranger, 'PO.ISSUE', SITE) && !can(stranger, 'MASTER.USER_ROLE_MANAGE', SITE));

  // --- the screen and the server must agree -----------------------------------
  // grantedKeys() drives which buttons render. If it disagreed with can(), the
  // API would accept calls the UI gives you no way to make.
  const keysForRequester = grantedKeys(requester);
  ok('grantedKeys agrees with can() for the requester',
     keysForRequester.includes('MR.APPROVE') === decisions &&
       keysForRequester.includes('PO.ISSUE') === everything,
     `${keysForRequester.length} of ${Object.keys(PERMISSION_MATRIX).length} keys granted`);

  ok('grantedKeys still gives nothing to somebody holding nothing',
     grantedKeys(principal(4, [], SITE)).length === 0);

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
