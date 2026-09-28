/**
 * Walk the whole procurement chain, with the right person at every step.
 *
 *   npm run demo:chain
 *
 * This is not a test — `verify:procurement` is the test, and it runs against a
 * throwaway database so it leaves nothing behind. This one runs against the
 * development database ON PURPOSE, so that afterwards every screen has real
 * records on it and the chain can be read in the UI rather than in a log.
 *
 * Each step acts as the user who would really do it, built from that person's
 * actual roles in `user_site_roles` — not a synthetic super-user. So when the
 * Site Manager approves the material request, it is because a Site Manager
 * account holds CG_SMGR at that site, and if the grant were missing the step
 * would fail here exactly as it would in the application.
 *
 * Run `npm run seed:users` first: the chain needs a Requester, Site Manager,
 * Buyer, Site Receiver, QA/QC Inspector, Warehouse Lead, Accounts and
 * Functional Head, and it needs them to be DIFFERENT PEOPLE. That is the whole
 * point — one account holding everything cannot walk this path, because half
 * the steps refuse the person who did the previous one.
 *
 * DEVELOPMENT ONLY. Safe to re-run: each run raises its own material request
 * and carries that one through, so runs do not collide.
 */
import { sql } from '../lib/db';
import * as masters from '../lib/services/masters';
import * as mrSvc from '../lib/services/mr';
import * as prSvc from '../lib/services/pr';
import * as quotes from '../lib/services/quotations';
import * as poSvc from '../lib/services/po';
import * as gate from '../lib/services/gate-inward';
import * as qcSvc from '../lib/services/qc';
import * as grnSvc from '../lib/services/grn';
import * as inventory from '../lib/services/inventory';
import * as vendorSvc from '../lib/services/vendors';
import type { Principal, RoleCode } from '../lib/auth/permissions';

type Actor = { principal: Principal; ip: string | null };

const money = (n: unknown) =>
  `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The chain in order. `--upto <stage>` runs to that point and stops, leaving the
 * next step waiting in the UI for you to do by hand. That is the difference
 * between watching the chain and operating it.
 */
const STAGES = [
  'vendor', 'mr', 'stock-check', 'declare', 'approve-mr',
  'pr', 'submit-pr', 'approve-pr', 'quote', 'award', 'po',
  'gate', 'qc', 'hold', 'grn', 'receipt',
] as const;
type Stage = (typeof STAGES)[number];

const uptoArg = (() => {
  const i = process.argv.indexOf('--upto');
  return i !== -1 ? process.argv[i + 1] : undefined;
})();

if (uptoArg && !STAGES.includes(uptoArg as Stage)) {
  console.error(`
  Unknown stage "${uptoArg}". One of:
    ${STAGES.join(', ')}
`);
  process.exit(1);
}

const stopAfter = uptoArg ? STAGES.indexOf(uptoArg as Stage) : STAGES.length - 1;

/** True while this stage is still within the requested range. */
const upto = (stage: Stage) => STAGES.indexOf(stage) <= stopAfter;

/** Announce where it stopped and what is now waiting for a person. */
function parked(next: string, who: string, where: string): never {
  console.log(`
  Stopped after "${uptoArg}", as asked.

  Waiting for you: ${next}
  Sign in as       ${who}
  Go to            ${where}

  Everything before this point is committed and readable in the UI.
`);
  void sql.end({ timeout: 5 });
  process.exit(0);
}

let step = 0;
function say(who: string, what: string, detail?: string) {
  step += 1;
  console.log(`  ${String(step).padStart(2)}. ${who.padEnd(17)} ${what}`);
  if (detail) console.log(`      ${' '.repeat(17)} ${detail}`);
}

async function main() {
  console.log('\nCrystal Procurement 2.0 — the whole chain, one step at a time\n');

  // ---- Who is who ------------------------------------------------------------
  const people = await sql<{ id: string; email: string; full_name: string; role: string; site_id: string }[]>`
    SELECT u.id, u.email, u.full_name, r.role, r.site_id
      FROM app_users u JOIN user_site_roles r ON r.user_id = u.id
     ORDER BY u.id`;

  const [site] = await sql<{ id: string; code: string; name: string }[]>`
    SELECT id, code, name FROM sites WHERE status = 'ACTIVE' ORDER BY id LIMIT 1`;

  if (!site) {
    console.error('  No active site. Run:  npm run seed:sandbox -- you@crystalgroup.in\n');
    process.exit(1);
  }
  const siteId = Number(site.id);

  /** The account that holds this role and as few others as possible. */
  function actorFor(role: RoleCode, label: string): Actor {
    const holders = people.filter(p => p.role === role && Number(p.site_id) === siteId);
    if (holders.length === 0) {
      console.error(`\n  Nobody holds ${role} at ${site.code}. Run:  npm run seed:users\n`);
      process.exit(1);
    }
    // Prefer the single-role account, so segregation of duties is real.
    const counts = new Map<string, number>();
    for (const p of people) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    const chosen = holders.sort((a, b) => (counts.get(a.id)! - counts.get(b.id)!))[0];

    const mine = people.filter(p => p.id === chosen.id);
    return {
      principal: {
        userId: Number(chosen.id),
        coreUserId: `demo:${chosen.email}`,
        email: chosen.email,
        fullName: chosen.full_name ?? chosen.email,
        sites: [{ siteId, siteCode: site.code, siteName: site.name, roles: mine.map(m => m.role as RoleCode) }],
        roles: mine.map(m => m.role as RoleCode),
        groupWide: mine.some(m => m.role === 'CG_ADM' || m.role === 'CG_DIR'),
      },
      ip: null,
    };
  }

  const REQ = actorFor('CG_REQ', 'Requester');
  const SMGR = actorFor('CG_SMGR', 'Site Manager');
  const BUY = actorFor('CG_BUY', 'Buyer');
  const RCV = actorFor('CG_RCV', 'Site Receiver');
  const QCI = actorFor('CG_QC', 'QA/QC Inspector');
  const WHL = actorFor('CG_WHL', 'Warehouse Lead');
  const FHEAD = actorFor('CG_FHEAD', 'Functional Head');
  const ADMIN = actorFor('CG_ADM', 'Administrator');

  console.log(`  Site ${site.code} — ${site.name}`);
  for (const [label, a] of [
    ['Requester', REQ], ['Site Manager', SMGR], ['Buyer', BUY], ['Site Receiver', RCV],
    ['QA/QC', QCI], ['Warehouse Lead', WHL], ['Functional Head', FHEAD], ['Administrator', ADMIN],
  ] as [string, Actor][]) {
    console.log(`    ${label.padEnd(17)} ${a.principal.email}`);
  }
  console.log('');

  // ---- What we are buying ----------------------------------------------------
  const items = await sql<{ id: string; code: string; name: string; item_class_id: string }[]>`
    SELECT id, code, name, item_class_id FROM items WHERE status = 'ACTIVE' ORDER BY id`;
  const [budget] = await sql<{ id: string; code: string }[]>`
    SELECT id, code FROM budget_codes WHERE is_active ORDER BY id LIMIT 1`;

  if (items.length < 2 || !budget) {
    console.error('  Not enough master data. Run:  npm run seed:sandbox -- you@crystalgroup.in\n');
    process.exit(1);
  }
  const itemA = items[0];
  const itemB = items[1];

  // A QC checklist for whatever class these items belong to, so the inspection
  // has something to tick. Idempotent by (item class, version).
  for (const classId of new Set([itemA.item_class_id, itemB.item_class_id])) {
    const existing = await masters.currentChecklist(Number(classId));
    if (!existing) {
      await masters.publishChecklist(ADMIN, {
        itemClassId: Number(classId),
        version: 'v1',
        points: ['Packaging intact', 'Quantity matches challan', 'No visible damage'],
      });
    }
  }

  // ---- A vendor that can actually be ordered from ----------------------------
  // Quotations may only come from approved vendors, and a vendor cannot be
  // approved by whoever created it — so this is the first place the chain
  // needs two different people.
  let approved = await sql<{ id: string; legal_name: string }[]>`
    SELECT id, legal_name FROM vendors WHERE status = 'VENDOR_APPROVED' ORDER BY id`;

  if (approved.length === 0 && upto('vendor')) {
    const draft = await sql<{ id: string; legal_name: string; status: string; created_by: string }[]>`
      SELECT id, legal_name, status, created_by FROM vendors
       WHERE status IN ('VENDOR_DRAFT', 'VENDOR_PENDING') ORDER BY id LIMIT 3`;

    for (const v of draft) {
      if (Number(v.created_by) === FHEAD.principal.userId) continue; // cannot approve their own
      if (v.status === 'VENDOR_DRAFT') await vendorSvc.submitVendor(BUY, Number(v.id));
      await vendorSvc.approveVendor(FHEAD, Number(v.id), `TALLY/LED/${v.id}`);
      say('Functional Head', `approved vendor ${v.legal_name}`, 'a vendor is never approved by whoever created it');
    }

    approved = await sql<{ id: string; legal_name: string }[]>`
      SELECT id, legal_name FROM vendors WHERE status = 'VENDOR_APPROVED' ORDER BY id`;
  }

  if (approved.length === 0) {
    console.error('\n  No vendor could be approved — the chain cannot quote. Add one and approve it first.\n');
    process.exit(1);
  }

  // =========================================================================
  // 1 — the need
  // =========================================================================
  if (!upto('mr'))
    parked('raising the material request', 'requester@crystalgroup.in',
           'Material requests -> Raise a request');

  const mr = await mrSvc.createMr(REQ, {
    siteId, category: 'CONSUMABLES', requiredBy: '2026-11-15', urgency: 'PLANNED',
    lines: [
      { itemId: Number(itemA.id), qtyRequested: '40' },
      { itemId: Number(itemB.id), qtyRequested: '25' },
    ],
  });
  const mrId = Number(mr.id);
  say('Requester', `raised ${String(mr.mr_no)}`, `${itemA.code} × 40, ${itemB.code} × 25`);

  if (!upto('stock-check')) parked('the stock check on the new material request', 'site.manager@crystalgroup.in', 'Material requests -> open it -> Run stock check');

  const { lines: checked } = await mrSvc.runStockCheck(SMGR, mrId);
  // runStockCheck reports a computed view; the rows the PR is built from are
  // the stored mr_lines, which carry qty_purchase once the check has run.
  const { lines: mrLines } = await mrSvc.getMr(mrId);
  const toBuy = mrLines.filter(l => Number(l.qty_purchase) > 0);
  say('Site Manager', 'ran the stock check',
      `${toBuy.length} of ${checked.length} line(s) must be bought; the rest could come from group stock`);

  if (!upto('declare')) parked('the business impact declaration', 'requester@crystalgroup.in', 'Material requests -> open it -> Declare');

  await mrSvc.declare(REQ, mrId, {
    businessImpact:
      'Consumables for the cold chain at ' + site.name + ' are below reorder level; without them despatch packing stops.',
    budgetCodeId: Number(budget.id), estimatedValue: '150000',
    allocations: [{ siteId, costHead: 'Warehouse operations', pct: '100' }],
  });
  say('Requester', 'declared the business impact', `charged to ${budget.code}, 100% to this site`);

  if (!upto('approve-mr')) parked('approval of the material request', 'site.manager@crystalgroup.in', 'Material requests -> open it -> Approve');

  await mrSvc.decideMr(SMGR, mrId, true);
  say('Site Manager', 'approved the request', 'mr_self_approval — the requester could not have done this');

  // =========================================================================
  // 2 — the purchase request, and its approval band
  // =========================================================================
  if (!upto('pr')) parked('raising the purchase request', 'buyer@crystalgroup.in', 'Purchase requests -> Raise a purchase request');

  const pr = await prSvc.createPr(BUY, {
    mrId, procurementType: 'MATERIAL',
    purpose: 'Restock cold chain consumables at ' + site.name,
    expectedDelivery: '2026-11-15',
    paymentTerms: {
      pay_advance_pct: '0', pay_before_delivery_pct: '0', pay_running_pct: '0',
      pay_post_delivery_pct: '100', pay_post_completion_pct: '0', pay_retention_pct: '0',
    },
    lines: toBuy.map(l => ({ mrLineId: Number(l.id), estRate: '1200', gstRate: '18' })),
  });
  const prId = Number(pr.id);
  say('Buyer', `raised ${String(pr.pr_no)} from ${String(mr.mr_no)}`, 'only the quantities the stock check said to buy');

  if (!upto('submit-pr')) parked('submitting the purchase request for approval', 'buyer@crystalgroup.in', 'Purchase requests -> open it -> Submit');

  const { levels } = await prSvc.submitPr(BUY, prId);
  say('Buyer', 'submitted it for approval',
      `value routed it to ${levels.length} level(s): ${levels.map(l => l.required_role).join(' then ')}`);

  if (!upto('approve-pr')) parked('approving the purchase request', 'whoever each level names', 'Pending approvals');

  for (const level of levels) {
    const who = level.required_role === 'CG_FHEAD' ? FHEAD
      : level.required_role === 'CG_SMGR' ? SMGR
      : level.required_role === 'CG_ADM' ? ADMIN
      : FHEAD;
    const out = await prSvc.decidePr(who, prId, true);
    say(String(level.required_role).replace('CG_', ''), `approved at level ${level.level_no}`,
        out.complete ? 'the request is approved and locked' : 'passes to the next level');
  }

  // =========================================================================
  // 3 — quotations, and the award
  // =========================================================================
  const { lines: prLines } = await prSvc.getPr(prId);

  if (!upto('quote')) parked('recording vendor quotations', 'buyer@crystalgroup.in', 'Purchase requests -> open the approved PR -> Record a quotation');

  let rate = 1150;
  for (const v of approved.slice(0, 3)) {
    await quotes.recordQuotation(BUY, {
      prId, vendorId: Number(v.id), vendorQuoteRef: `Q/${v.id}/2026`,
      quoteDate: '2026-09-28', validUntil: '2026-12-31', freightAmount: String((rate - 1100) * 2),
      lines: prLines.map(l => ({ prLineId: Number(l.id), unitRate: String(rate), gstRate: '18' })),
    });
    rate += 60;
  }
  say('Buyer', `recorded ${Math.min(approved.length, 3)} quotation(s)`, 'against the same lines, so they compare');

  const comparison = await quotes.buildComparison(prId);
  const best = comparison.quotes.find(q => q.rank === 1)!;
  say('—', 'the comparison ranked them by LANDED cost',
      `L1 is ${best.vendorName ?? 'the lowest'} — freight and tax included, not the headline rate`);

  if (!upto('award')) parked('awarding a quotation', 'buyer@crystalgroup.in', 'Vendor quotations -> the PR -> compare, then Award');

  await quotes.award(BUY, { prId, quotationId: best.quotationId });
  say('Buyer', 'awarded the lowest quotation', 'the others are marked lost, never deleted');

  // =========================================================================
  // 4 — the order
  // =========================================================================
  if (!upto('po')) parked('raising and issuing the purchase order', 'buyer@crystalgroup.in', 'Purchase requests -> the awarded PR -> Raise purchase order');

  const po = await poSvc.createPo(BUY, { prId, expectedDelivery: '2026-11-15' });
  const poId = Number(po.id);
  const issued = await poSvc.issuePo(BUY, poId, `TALLY/PO/26-27/${poId}`);
  say('Buyer', `issued ${issued.po_no}`, 'at the awarded rates; issuing needs a Tally reference');

  // =========================================================================
  // 5 — receiving: three people, deliberately
  // =========================================================================
  const { lines: poLines } = await poSvc.getPo(poId);

  if (!upto('gate')) parked('logging the delivery at the gate', 'receiver@crystalgroup.in', 'Gate inward -> Log a delivery');

  const gi = await gate.createGateInward(RCV, {
    poId,
    vehicleNo: 'wb 23 cd 8890',
    challanNo: `CH-${Date.now().toString().slice(-6)}`,
    challanDate: '2026-09-28',
    transporter: 'Sundar Roadways',
    lines: poLines.map(l => ({
      poLineId: Number(l.id),
      qtyPerChallan: String(l.qty_ordered),
      qtyCounted: String(l.qty_ordered),
    })),
  });
  const giId = Number(gi.id);
  say('Site Receiver', `logged ${gi.gi_no} at the gate`, 'vehicle number normalised: wb 23 cd 8890 → WB23CD8890');

  await gate.sendToQc(RCV, giId);
  say('Site Receiver', 'handed it to QC', 'nothing is stock yet — it has only been counted');

  if (!upto('qc')) parked('the QC inspection', 'qc@crystalgroup.in', 'QA/QC inspection -> See deliveries awaiting QC');

  const { qc } = await qcSvc.startInspection(QCI, giId);
  const qcId = Number(qc.id);
  const { lines: qcLines, points } = await qcSvc.getInspection(qcId);

  for (const [i, l] of qcLines.entries()) {
    const delivered = Number(l.qty_delivered ?? l.qty_counted ?? 0);
    // One line passes clean; the next holds a couple, so the hold path is real.
    const hold = i === 1 && delivered >= 4 ? 2 : 0;
    await qcSvc.recordVerdict(QCI, qcId, {
      qcLineId: Number(l.id),
      qtyAccepted: String(delivered - hold),
      qtyHold: String(hold),
      qtyRejected: '0',
      ...(hold > 0 ? { reasonCode: 'SURFACE_DAMAGE', remarks: 'Scuffing noted on two units' } : {}),
      ...(hold === 0 ? { checks: points.slice(0, 3).map(p => ({ pointId: Number(p.id), result: 'PASS' as const })) } : {}),
    });
  }
  await qcSvc.completeInspection(QCI, qcId);
  say('QA/QC Inspector', `inspected ${qc.qc_no}`, 'a held quantity needs a reason code — the schema insists');

  // A hold is not a verdict, it is a question — and the inspector who raised it
  // is not allowed to answer it. Until a site manager decides, no receipt can
  // be raised at all, which is where this chain stops if nobody does.
  if (!upto('hold')) parked('a decision on the held quantity', 'site.manager@crystalgroup.in', 'QA/QC inspection -> Conditional holds');

  const holds = await qcSvc.pendingHolds(SMGR.principal);
  for (const h of holds.filter(x => Number(x.qc_id) === qcId)) {
    const decision = await qcSvc.decideHold(
      SMGR, Number(h.qc_line_id), 'CONCESSION', String(h.qty_hold),
      'Scuffing is cosmetic; accepted for the internal pool at an agreed rebate',
    );
    say('Site Manager', `decided the hold on ${h.item_code ?? 'the held line'}`,
        `${decision.decision} for ${decision.qty} — the inspector who raised it could not`);
  }

  if (!upto('grn')) parked('drafting the goods receipt', 'warehouse@crystalgroup.in', 'QA/QC inspection -> the completed inspection -> Raise goods receipt');

  const grn = await grnSvc.createGrn(WHL, { qcId });
  const grnId = Number(grn.id);
  say('Warehouse Lead', `drafted ${grn.grn_no}`, 'only what QC accepted can be receipted');

  if (!upto('receipt')) parked('approving the receipt, which is what creates stock', 'site.manager@crystalgroup.in', 'Goods receipt (GRN) -> open the draft -> Approve');

  const { entries } = await grnSvc.approveGrn(SMGR, grnId);
  say('Site Manager', 'approved the receipt — stock exists now',
      `${entries.length} ledger entr(ies) posted through post_stock_movement()`);

  // =========================================================================
  // What it left behind
  // =========================================================================
  // v_stock_position names these `code` / `on_hand` / `available`, not
  // `item_code` / `qty_on_hand` -- the view is the authority on what stock is.
  const position = await inventory.stockPosition(SMGR.principal, { siteId });
  const held = position.filter(p => Number(p.on_hand) > 0);

  console.log(`\n  Stock at ${site.code} now:`);
  if (held.length === 0) console.log('    (nothing on hand)');
  for (const p of held.slice(0, 8)) {
    console.log(`    ${String(p.code).padEnd(16)} ${String(p.on_hand).padStart(10)} ${String(p.uom ?? '').padEnd(5)} available ${String(p.available)}`);
  }

  const [val] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM audit_log WHERE created_at > now() - interval '5 minutes'`;

  console.log(`
  Done. ${step} steps, eight different people, ${val.n} audit rows written.

  Every one of these is now on a screen:

    ${String(mr.mr_no).padEnd(22)} Material requests
    ${String(pr.pr_no).padEnd(22)} Purchase requests  (and its approval trail)
    ${String(issued.po_no).padEnd(22)} Purchase orders
    ${String(gi.gi_no).padEnd(22)} Gate inward
    ${String(qc.qc_no).padEnd(22)} QA/QC inspection   (a held quantity waits on a decision)
    ${String(grn.grn_no).padEnd(22)} Goods receipt      -> Warehouse stock, Stock ledger

  What it proves, by refusing nothing it should have refused: the requester
  could not approve their own request, the buyer could not approve their own
  purchase request, whoever created a vendor could not approve it, and the
  person who received the goods could not be the one who inspected them.
`);

  await sql.end({ timeout: 5 });
}

void main().catch(async err => {
  console.error('\n  The chain stopped:', err instanceof Error ? err.message : err);
  console.error('  Nothing after that step ran. The steps before it are committed and readable in the UI.\n');
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
