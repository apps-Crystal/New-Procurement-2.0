import { sql } from '../lib/db';
import { pendingApprovals, pendingFor } from '../lib/services/approvals';
import { openApprovals } from '../lib/auth/permissions';
import { inTransaction } from '../lib/db';
import { getPrincipal } from '../lib/auth/permissions';

(async () => {
  console.log('\n  openApprovals():', openApprovals(), '\n');
  for (const email of ['site.manager@crystalgroup.in', 'qc@crystalgroup.in', 'accounts@crystalgroup.in']) {
    const p = await getPrincipal(`local:${email}`);
    if (!p) { console.log(`  ${email}: no principal`); continue; }
    const raw = await inTransaction(tx => pendingFor(tx, p));
    const out = await pendingApprovals(p);
    console.log(`  ${email}`);
    console.log(`    roles=${p.roles.join(',')} sites=${p.sites.map(s => s.siteId).join(',')} groupWide=${p.groupWide} userId=${p.userId}`);
    console.log(`    pendingFor -> ${raw.length}   pendingApprovals -> ${out.length}`);
  }
  const [pr] = await sql<{ id: string; requester_id: string; site_id: string }[]>`
    SELECT id, requester_id, site_id FROM purchase_requests ORDER BY id DESC LIMIT 1`;
  console.log(`\n  newest PR ${pr.id}: requester_id=${pr.requester_id} site_id=${pr.site_id}\n`);
  await sql.end({ timeout: 2 });
})().catch(e => { console.error('  ' + e.message); process.exit(1); });
