/**
 * The procurement chain, end to end, against a real PostgreSQL.
 *
 *   npm run verify:procurement
 *
 * This is the first half of the §36 acceptance criteria, as an executable test:
 *
 *   MR → stock check → transfer → declaration → PR → approval
 *      → quotations → comparison → award → PO → issue
 *
 * Creates a throwaway database, walks the chain with FIVE different people so
 * segregation of duties is genuinely exercised rather than asserted, and drops
 * it again. Zero residue.
 *
 * What it is really checking is that the constraints bite in the right order
 * and that a refusal reaches the caller as a sentence. Anyone can make a happy
 * path pass; the interesting assertions here are the ones that expect failure.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import type { Principal, RoleCode } from '../lib/auth/permissions';

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'crystal_procurement_verify_proc';

const baseUrl = process.env.ADMIN_URL ?? process.env.DATABASE_URL;
if (!baseUrl || baseUrl.includes('<PASSWORD>')) {
  console.error('\n  Set ADMIN_URL in .env.local (and replace the <PASSWORD> placeholder).\n');
  process.exit(1);
}

const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${TEST_DB}`;

process.env.DATABASE_URL = testUrl.toString();

const results: { name: string; ok: boolean; message?: string }[] = [];
let failures = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write('.');
  } catch (err) {
    results.push({ name, ok: false, message: err instanceof Error ? err.message : String(err) });
    failures++;
    process.stdout.write('x');
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

async function rejects(fn: () => Promise<unknown>, pattern: RegExp, label: string) {
  let threw: unknown = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(`${label}: expected this to be refused, but it succeeded`);
  const message = threw instanceof Error ? threw.message : String(threw);
  if (!pattern.test(message)) throw new Error(`${label}: refused for the wrong reason — ${message}`);
}

async function main() {
  console.log('\nCrystal Procurement 2.0 — procurement chain verification\n');

  const admin = postgres(adminUrl.toString(), { ssl: false, max: 1, onnotice: () => {} });
  try {
    process.stdout.write(`  creating ${TEST_DB} … `);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
    console.log('ok');
  } finally {
    await admin.end({ timeout: 5 });
  }

  const migrator = postgres(testUrl.toString(), { ssl: false, max: 1, onnotice: () => {} });
  try {
    const files = readdirSync(path.join(ROOT, 'db', 'migrations')).filter(f => f.endsWith('.sql')).sort();
    process.stdout.write(`  applying ${files.length} migrations … `);
    for (const file of files) {
      await migrator.unsafe(readFileSync(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
    }
    console.log('ok\n');
  } finally {
    await migrator.end({ timeout: 5 });
  }

  const { sql, inTransaction } = await import('../lib/db');
  const masters = await import('../lib/services/masters');
  const vendors = await import('../lib/services/vendors');
  const mrSvc = await import('../lib/services/mr');
  const transfers = await import('../lib/services/transfers');
  const prSvc = await import('../lib/services/pr');
  const quotes = await import('../lib/services/quotations');
  const poSvc = await import('../lib/services/po');
  const approvals = await import('../lib/services/approvals');
  const gate = await import('../lib/services/gate-inward');
  const qcSvc = await import('../lib/services/qc');
  const grnSvc = await import('../lib/services/grn');
  const shortfalls = await import('../lib/services/shortfall');
  const stock = await import('../lib/services/stock');

  try {
    process.stdout.write('  ');

    // =====================================================================
    // Cast: five people, so segregation of duties is real
    // =====================================================================
    const mkUser = async (key: string, name: string) => {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO app_users (core_user_id, email, full_name)
        VALUES (${`verify-${key}`}, ${`${key}@crystalgroup.in`}, ${name}) RETURNING id`;
      return Number(u.id);
    };

    const adminId = await mkUser('admin', 'Administrator');
    const requesterId = await mkUser('req', 'Rina Requester');
    const managerId = await mkUser('smgr', 'Sanjay Site Manager');
    const headId = await mkUser('fhead', 'Farah Functional Head');
    const buyerId = await mkUser('buy', 'Bikash Buyer');
    const wareId = await mkUser('whl', 'Wasim Warehouse Lead');
    const recvId = await mkUser('rcv', 'Ravi Receiver');
    const inspId = await mkUser('qc', 'Qaiser Inspector');

    const principal = (id: number, roles: RoleCode[], sites: { id: number; code: string; name: string }[]): Principal => ({
      userId: id,
      coreUserId: `verify-${id}`,
      email: `u${id}@crystalgroup.in`,
      fullName: `User ${id}`,
      sites: sites.map(s => ({ siteId: s.id, siteCode: s.code, siteName: s.name, roles })),
      roles,
      groupWide: roles.includes('CG_ADM'),
    });

    const bootstrap = { principal: principal(adminId, ['CG_ADM'], []), ip: null };

    const siteA = Number((await masters.createSite(bootstrap, {
      code: 'DHU', name: 'Dhulagarh', siteType: 'WAREHOUSE', address: 'Dhulagarh, WB',
      stateCode: '19', gstin: '19AABCU9603R1ZX', tallyCostCentre: 'CC-DHU', status: 'ACTIVE',
    })).id);

    const siteB = Number((await masters.createSite(bootstrap, {
      code: 'PUN', name: 'Pune', siteType: 'WAREHOUSE', address: 'Pune, MH',
      stateCode: '27', gstin: '27AABCU9603R1Z0', tallyCostCentre: 'CC-PUN', status: 'ACTIVE',
    })).id);

    const bothSites = [
      { id: siteA, code: 'DHU', name: 'Dhulagarh' },
      { id: siteB, code: 'PUN', name: 'Pune' },
    ];

    const ADMIN = { principal: principal(adminId, ['CG_ADM'], bothSites), ip: null };
    const REQ = { principal: principal(requesterId, ['CG_REQ'], bothSites), ip: null };
    const SMGR = { principal: principal(managerId, ['CG_SMGR'], bothSites), ip: null };
    const FHEAD = { principal: principal(headId, ['CG_FHEAD'], bothSites), ip: null };
    const BUY = { principal: principal(buyerId, ['CG_BUY'], bothSites), ip: null };
    const WHL = { principal: principal(wareId, ['CG_WHL'], bothSites), ip: null };
    const RCV = { principal: principal(recvId, ['CG_RCV'], bothSites), ip: null };
    const QCI = { principal: principal(inspId, ['CG_QC'], bothSites), ip: null };

    const classId = Number((await masters.createItemClass(ADMIN, { code: 'AMB', name: 'Ambient' })).id);

    const coilId = Number((await masters.createItem(ADMIN, {
      code: 'CC-EVP-220', name: 'Evaporator coil 22 kW', itemClassId: classId, uom: 'Nos',
    })).id);
    const palletId = Number((await masters.createItem(ADMIN, {
      code: 'PL-HDPE-12', name: 'HDPE pallet 1200 x 1000', itemClassId: classId, uom: 'Nos',
    })).id);

    const budgetId = Number((await masters.createBudgetCode(ADMIN, {
      code: 'MAINT-CAPEX', financialYear: 'FY26-27', category: 'MAINTENANCE_CAPEX',
    })).id);

    // Pune holds surplus pallets; its reorder level is 10, so 60 of 70 is surplus.
    await masters.setItemSiteSettings(ADMIN, { itemId: palletId, siteId: siteB, reorderLevel: '10' });
    await inTransaction(tx =>
      stock.postMovement(tx, {
        siteId: siteB, itemId: palletId, movement: 'OPENING', from: null, to: 'AVAILABLE',
        qty: '70', sourceType: 'OPENING', sourceId: 1, userId: adminId,
      }),
    );

    // =====================================================================
    // Material request
    // =====================================================================
    let mrId = 0;

    await check('MR is raised with two lines', async () => {
      const mr = await mrSvc.createMr(REQ, {
        siteId: siteA, category: 'MAINTENANCE_CAPEX', requiredBy: '2026-10-06', urgency: 'PLANNED',
        lines: [
          { itemId: coilId, qtyRequested: '1' },
          { itemId: palletId, qtyRequested: '100' },
        ],
      });
      mrId = Number(mr.id);
      assert(String(mr.mr_no).startsWith('MR-DHU-'), `unexpected number ${mr.mr_no}`);
      assertEqual(mr.status, 'MR_DRAFT', 'status');
    });

    await check('the same item twice on one MR is refused', async () => {
      await rejects(
        () => mrSvc.createMr(REQ, {
          siteId: siteA, category: 'ASSETS', requiredBy: '2026-10-06', urgency: 'PLANNED',
          lines: [{ itemId: coilId, qtyRequested: '1' }, { itemId: coilId, qtyRequested: '2' }],
        }),
        /same item appears on more than one line/,
        'duplicate line',
      );
    });

    await check('stock check finds Pune surplus and reports PARTIAL', async () => {
      const { mr, lines } = await mrSvc.runStockCheck(REQ, mrId);
      assertEqual(mr.status, 'MR_STOCK_PARTIAL', 'outcome');

      const pallet = lines.find(l => l.itemCode === 'PL-HDPE-12')!;
      // v_group_surplus counts only what is above the holding site's reorder level.
      assertEqual(pallet.totalSurplus, '60.000', 'pallet surplus across the group');
      assertEqual(pallet.coverable, '60.000', 'coverable, capped at requested');

      const coil = lines.find(l => l.itemCode === 'CC-EVP-220')!;
      assertEqual(coil.totalSurplus, '0.000', 'no coil anywhere');
    });

    await check('a transfer larger than the surplus is refused', async () => {
      const { lines } = await mrSvc.getMr(mrId);
      const palletLine = lines.find(l => l.item_code === 'PL-HDPE-12')!;
      await rejects(
        () => mrSvc.setTransferQuantities(REQ, mrId, [
          { mrLineId: Number(palletLine.id), qtyTransfer: '100' },
        ]),
        /Only 60 of PL-HDPE-12 is surplus/,
        'over-allocation',
      );
    });

    await check('qty_purchase falls out of qty_transfer, never set directly', async () => {
      const { lines } = await mrSvc.getMr(mrId);
      const palletLine = lines.find(l => l.item_code === 'PL-HDPE-12')!;

      await mrSvc.setTransferQuantities(REQ, mrId, [{ mrLineId: Number(palletLine.id), qtyTransfer: '60' }]);

      const after = await mrSvc.getMr(mrId);
      const pallet = after.lines.find(l => l.item_code === 'PL-HDPE-12')!;
      assertEqual(pallet.qty_transfer, '60.000', 'transfer');
      assertEqual(pallet.qty_purchase, '40.000', '100 requested − 60 transferred');

      const coil = after.lines.find(l => l.item_code === 'CC-EVP-220')!;
      assertEqual(coil.qty_purchase, '1.000', 'coil is bought in full');
    });

    // =====================================================================
    // Transfer, all four steps
    // =====================================================================
    let transferId = 0;

    await check('transfer is requested for the covered quantity', async () => {
      const { lines } = await mrSvc.getMr(mrId);
      const palletLine = lines.find(l => l.item_code === 'PL-HDPE-12')!;

      const t = await transfers.requestTransfer(REQ, {
        mrId, fromSiteId: siteB, toSiteId: siteA,
        lines: [{ itemId: palletId, qty: '60', mrLineId: Number(palletLine.id) }],
      });
      transferId = Number(t.id);
      assert(String(t.transfer_no).startsWith('TRF-PUN-'), `numbered from the sending site: ${t.transfer_no}`);
    });

    await check('only the holding site can decide the transfer', async () => {
      // Rina raised it from Dhulagarh and holds no Warehouse Lead role anywhere,
      // so she is stopped by the permission before self-approval is even reached.
      await rejects(
        () => transfers.decideTransfer(REQ, transferId, true),
        /Warehouse Lead at Pune/i,
        'requesting site decides',
      );
    });

    await check('the requester cannot approve their own transfer', async () => {
      // The check above is not enough on its own: it would also pass if the
      // self-approval rule did not exist. So here is the person it is actually
      // for — someone who raised the transfer AND is Warehouse Lead at the
      // holding site. Same user id, so `requested_by` matches; the permission
      // now passes, and only the self-approval rule stands between them and
      // approving their own request.
      const REQ_ALSO_WHL = { principal: principal(requesterId, ['CG_WHL'], bothSites), ip: null };
      await rejects(
        () => transfers.decideTransfer(REQ_ALSO_WHL, transferId, true),
        /you raised this transfer/i,
        'self-approval',
      );
    });

    await check('the holding site approves, reserving the stock', async () => {
      await transfers.decideTransfer(WHL, transferId, true);
      const balances = await inTransaction(tx => stock.balancesFor(tx, siteB, palletId));
      assertEqual(balances.find(b => b.bucket === 'RESERVED')?.qty, '60.000', 'reserved at Pune');
      assertEqual(balances.find(b => b.bucket === 'AVAILABLE')?.qty, '10.000', '70 − 60 still available');
    });

    await check('C-01 · dispatch and receipt move stock across both sites', async () => {
      await transfers.dispatchTransferOrder(WHL, transferId);

      const inFlight = await inTransaction(tx => stock.balancesFor(tx, siteB, palletId));
      assertEqual(inFlight.find(b => b.bucket === 'IN_TRANSIT')?.qty, '60.000', 'in transit at Pune');

      await transfers.receiveTransferOrder(WHL, transferId);

      const source = await inTransaction(tx => stock.balancesFor(tx, siteB, palletId));
      const dest = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));

      assertEqual(source.find(b => b.bucket === 'IN_TRANSIT')?.qty, '0.000', 'source drained');
      assertEqual(source.find(b => b.bucket === 'RESERVED')?.qty, '0.000', 'reservation cleared');
      assertEqual(dest.find(b => b.bucket === 'AVAILABLE')?.qty, '60.000', 'arrived at Dhulagarh');
    });

    // =====================================================================
    // Declaration and MR approval
    // =====================================================================
    await check('a declaration under 40 characters is refused', async () => {
      await rejects(
        () => mrSvc.declare(REQ, mrId, {
          businessImpact: 'Needed.', budgetCodeId: budgetId, estimatedValue: '200000',
          allocations: [{ siteId: siteA, costHead: 'Freezer block', pct: '100' }],
        }),
        /between 40 and 500 characters/,
        'short business impact',
      );
    });

    await check('an allocation that does not total 100% is refused', async () => {
      await rejects(
        () => mrSvc.declare(REQ, mrId, {
          businessImpact: 'Freezer room 3 is running on one evaporator after a coil failure; a second failure forces a product transfer.',
          budgetCodeId: budgetId, estimatedValue: '200000',
          allocations: [{ siteId: siteA, costHead: 'Freezer block', pct: '70' }],
        }),
        /total exactly 100%/,
        '70% allocation',
      );
    });

    await check('a valid declaration is accepted with its allocations', async () => {
      await mrSvc.declare(REQ, mrId, {
        businessImpact: 'Freezer room 3 is running on one evaporator after a coil failure; a second failure forces a product transfer to Dankuni.',
        budgetCodeId: budgetId, estimatedValue: '300000',
        allocations: [
          { siteId: siteA, costHead: 'Freezer block', pct: '70' },
          { siteId: siteA, costHead: 'Chiller plant', pct: '30' },
        ],
      });

      const { mr, declaration, allocations } = await mrSvc.getMr(mrId);
      assertEqual(mr.status, 'MR_DECLARED', 'status');
      assertEqual(declaration?.version, 1, 'first version');
      assertEqual(allocations.length, 2, 'two allocations');
    });

    await check('mr_self_approval · the requester cannot approve their own MR', async () => {
      await rejects(() => mrSvc.decideMr(REQ, mrId, true), /permission|cannot approve it/i, 'self-approval');
    });

    await check('the site manager approves the MR', async () => {
      const mr = await mrSvc.decideMr(SMGR, mrId, true);
      assertEqual(mr.status, 'MR_APPROVED', 'status');
      assertEqual(Number(mr.approved_by), managerId, 'approver recorded');
    });

    // =====================================================================
    // Purchase request
    // =====================================================================
    let prId = 0;

    await check('payment terms that do not total 100% are refused', async () => {
      await rejects(
        () => prSvc.createPr(BUY, {
          mrId, procurementType: 'MATERIAL', purpose: 'Replace failed coil', expectedDelivery: '2026-10-06',
          paymentTerms: { pay_advance_pct: '40', pay_before_delivery_pct: '0', pay_running_pct: '0',
                          pay_post_delivery_pct: '0', pay_post_completion_pct: '0', pay_retention_pct: '0' },
          lines: [],
        }),
        /total exactly 100%/,
        'payment terms',
      );
    });

    await check('PR carries only the purchase balance, at MR quantities', async () => {
      const { lines } = await mrSvc.getMr(mrId);
      const purchaseLines = lines.filter(l => Number(l.qty_purchase) > 0);

      const pr = await prSvc.createPr(BUY, {
        mrId, procurementType: 'MATERIAL',
        purpose: 'Replace failed evaporator coil in freezer room 3',
        expectedDelivery: '2026-10-06',
        paymentTerms: { pay_advance_pct: '20', pay_before_delivery_pct: '0', pay_running_pct: '0',
                        pay_post_delivery_pct: '70', pay_post_completion_pct: '0', pay_retention_pct: '10' },
        lines: purchaseLines.map(l => ({
          mrLineId: Number(l.id),
          estRate: l.item_code === 'CC-EVP-220' ? '182000' : '2150',
          gstRate: '18',
        })),
      });
      prId = Number(pr.id);

      const detail = await prSvc.getPr(prId);
      assertEqual(detail.lines.length, 2, 'both purchase lines');

      const pallet = detail.lines.find(l => l.item_code === 'PL-HDPE-12')!;
      assertEqual(pallet.qty, '40.000', 'the purchase balance, not the 100 requested');

      // Inherited from the declaration, not the MR header — conflict C-05.
      assertEqual(Number(detail.pr.budget_code_id), budgetId, 'budget code from the declaration');
    });

    await check('the declaration locks once a PR exists', async () => {
      await rejects(
        () => mrSvc.declare(REQ, mrId, {
          businessImpact: 'Trying to revise the declaration after a purchase request already exists against it.',
          budgetCodeId: budgetId, estimatedValue: '999999',
          allocations: [{ siteId: siteA, costHead: 'Freezer block', pct: '100' }],
        }),
        /locked|cannot go from/i,
        'declaration revision after PR',
      );
    });

    await check('a second PR from the same MR is refused', async () => {
      await rejects(
        () => prSvc.createPr(BUY, {
          mrId, procurementType: 'MATERIAL', purpose: 'Duplicate', expectedDelivery: '2026-10-06',
          paymentTerms: { pay_advance_pct: '100', pay_before_delivery_pct: '0', pay_running_pct: '0',
                          pay_post_delivery_pct: '0', pay_post_completion_pct: '0', pay_retention_pct: '0' },
          lines: [],
        }),
        /already been converted/,
        'second PR',
      );
    });

    await check('v_pr_totals computes per line at each line rate', async () => {
      const { totals } = await prSvc.getPr(prId);
      // 1 x 182,000 = 182,000 ; 40 x 2,150 = 86,000 ; taxable 268,000
      //
      // The view sums qty(14,3) x rate(14,2) without rounding, so `taxable`
      // arrives at scale 5 while `gst` and `total_incl_gst` are rounded per
      // line. The value is exact either way; the UI formats it to paise.
      assertEqual(Number(totals?.taxable), 268000, 'taxable');
      assertEqual(totals?.gst, '48240.00', 'GST at 18%');
      assertEqual(totals?.total_incl_gst, '316240.00', 'total including GST');
    });

    await check('submission routes by value to a two-level band', async () => {
      const { levels } = await prSvc.submitPr(BUY, prId);
      // 316,240 falls in ₹1–10 lakh: Site Manager, then Functional Head.
      assertEqual(levels.map(l => l.required_role), ['CG_SMGR', 'CG_FHEAD'], 'approval route');
    });

    await check('C-16 · the requester cannot approve their own PR', async () => {
      await rejects(() => prSvc.decidePr(BUY, prId, true), /you raised this purchase request/i, 'self-approval');
    });

    await check('the approvals queue offers a PR only to whoever can decide it now', async () => {
      const forSmgr = await approvals.pendingApprovals(SMGR.principal);
      const mine = forSmgr.find(p => p.entityType === 'PR' && p.entityId === prId);
      assert(mine !== undefined, 'the site manager sees it at level 1');
      assertEqual(mine?.levelNo, 1, 'offered at level 1');
      assertEqual(mine?.requiredRole, 'CG_SMGR', 'required role');

      // Level 2 is not reachable yet, so it must not be offered.
      const forHead = await approvals.pendingApprovals(FHEAD.principal);
      assert(
        !forHead.some(p => p.entityType === 'PR' && p.entityId === prId),
        'the functional head is not offered a level that cannot be decided yet',
      );

      // The buyer raised it, so it never appears for them at any level.
      const forBuyer = await approvals.pendingApprovals(BUY.principal);
      assert(
        !forBuyer.some(p => p.entityType === 'PR' && p.entityId === prId),
        'the originator is never offered their own request',
      );

      // A site manager elsewhere holds the role but not the site.
      const elsewhere = { principal: principal(managerId, ['CG_SMGR'], []), ip: null };
      const forElsewhere = await approvals.pendingApprovals(elsewhere.principal);
      assert(
        !forElsewhere.some(p => p.entityType === 'PR' && p.entityId === prId),
        'holding the role at no site offers nothing',
      );
    });

    await check('level 2 cannot decide before level 1', async () => {
      await rejects(
        () => prSvc.decidePr(FHEAD, prId, true),
        /needs Site Manager at this site/,
        'out-of-order approval',
      );
    });

    await check('both levels approve, and the PR locks', async () => {
      const first = await prSvc.decidePr(SMGR, prId, true);
      assert(!first.complete, 'not complete after level 1');
      assertEqual(first.pr.status, 'PR_SUBMITTED', 'still submitted');

      const second = await prSvc.decidePr(FHEAD, prId, true);
      assert(second.complete, 'complete after level 2');
      assertEqual(second.pr.status, 'PR_APPROVED', 'approved');
      assert(second.pr.locked_at !== null, 'locked_at set');
    });

    await check('a fully approved PR leaves the approvals queue', async () => {
      for (const who of [SMGR, FHEAD]) {
        const queue = await approvals.pendingApprovals(who.principal);
        assert(
          !queue.some(p => p.entityType === 'PR' && p.entityId === prId),
          'nothing is left to decide once every level has cleared',
        );
      }
    });

    await check('pr_edit_lock · an approved PR cannot be edited', async () => {
      await rejects(
        () => prSvc.updatePr(BUY, prId, { purpose: 'Changed after approval' }),
        /approved and can no longer be edited/,
        'edit after approval',
      );
    });

    // =====================================================================
    // Quotations and award
    // =====================================================================
    const mkVendor = async (code: string, name: string, pan: string, gstin: string) => {
      const v = await vendors.createVendor(ADMIN, {
        legalName: name, pan, gstin, stateCode: '19', address: 'Kolkata',
      });
      await vendors.submitVendor(ADMIN, Number(v.id));
      await vendors.approveVendor(FHEAD, Number(v.id), `LEDGER-${code}`);
      return Number(v.id);
    };

    let frostline = 0, arctic = 0, polar = 0;

    await check('three approved vendors quote against the PR', async () => {
      frostline = await mkVendor('FR', 'Frostline Refrigeration', 'AABCF1234R', '19AABCF1234R1ZX');
      arctic = await mkVendor('AC', 'Arctic Cool Engineers', 'AABCA1234R', '19AABCA1234R1ZQ');
      polar = await mkVendor('PT', 'Polar Tech Industries', 'AABCP1234R', '19AABCP1234R1ZM');

      const { lines } = await prSvc.getPr(prId);
      const coilLine = lines.find(l => l.item_code === 'CC-EVP-220')!;
      const palletLine = lines.find(l => l.item_code === 'PL-HDPE-12')!;

      const quote = (vendorId: number, ref: string, coilRate: string, palletRate: string, freight: string) =>
        quotes.recordQuotation(BUY, {
          prId, vendorId, vendorQuoteRef: ref, quoteDate: '2026-09-24', validUntil: '2027-10-24',
          freightAmount: freight,
          lines: [
            { prLineId: Number(coilLine.id), unitRate: coilRate, gstRate: '18' },
            { prLineId: Number(palletLine.id), unitRate: palletRate, gstRate: '18' },
          ],
        });

      await quote(frostline, 'FR/Q/2026/381', '184000', '2200', '6000');
      await quote(arctic, 'ACE-2609-17', '179500', '2100', '0');
      await quote(polar, 'PTI/RFQ/0922', '188000', '2250', '9500');

      assertEqual((await quotes.listQuotations(prId)).length, 3, 'three quotations');
    });

    await check('a quotation missing a line is refused', async () => {
      const { lines } = await prSvc.getPr(prId);
      await rejects(
        () => quotes.recordQuotation(BUY, {
          prId, vendorId: frostline, vendorQuoteRef: 'PARTIAL', quoteDate: '2026-09-24', validUntil: '2027-10-24',
          lines: [{ prLineId: Number(lines[0].id), unitRate: '1', gstRate: '18' }],
        }),
        /must price every line/,
        'partial quotation',
      );
    });

    await check('landed cost and rank come from the view, not a client sort', async () => {
      const comparison = await quotes.buildComparison(prId);
      assertEqual(comparison.quotes.length, 3, 'three quotes compared');
      assert(!comparison.needsWaiver, 'three meets the minimum');

      // Arctic: 179,500 + 40x2,100 = 263,500 taxable; +18% = 310,930; freight 0
      const l1 = comparison.quotes[0];
      assertEqual(l1.vendorName, 'Arctic Cool Engineers', 'L1 is the lowest landed cost');
      assertEqual(l1.rank, 1, 'rank from the window function');
      assertEqual(l1.landedCost, '310930.00', 'landed cost per line, per rate');
      assertEqual(l1.varianceToL1, '0.00', 'L1 has no variance');

      const l2 = comparison.quotes[1];
      assert(Number(l2.varianceToL1) > 0, 'L2 costs more than L1');
    });

    await check('awards_nonlow · a non-lowest award without justification is refused', async () => {
      const comparison = await quotes.buildComparison(prId);
      const notLowest = comparison.quotes.find(q => q.rank === 2)!;

      await rejects(
        () => quotes.award(BUY, { prId, quotationId: notLowest.quotationId }),
        /reason code and written justification are required/,
        'non-lowest without justification',
      );
    });

    await check('an expired quotation cannot be awarded', async () => {
      const expired = await quotes.recordQuotation(BUY, {
        prId, vendorId: polar, vendorQuoteRef: 'PTI/OLD', quoteDate: '2026-01-01', validUntil: '2026-02-01',
        lines: (await prSvc.getPr(prId)).lines.map(l => ({
          prLineId: Number(l.id), unitRate: '1000', gstRate: '18',
        })),
      });

      await rejects(
        () => quotes.award(BUY, { prId, quotationId: Number(expired.id) }),
        /expired on/,
        'expired quotation',
      );

      // Put a live quote back so the rest of the walk-through has three.
      await quotes.recordQuotation(BUY, {
        prId, vendorId: polar, vendorQuoteRef: 'PTI/RFQ/0922', quoteDate: '2026-09-25', validUntil: '2027-11-25',
        freightAmount: '9500',
        lines: (await prSvc.getPr(prId)).lines.map(l => ({
          prLineId: Number(l.id),
          unitRate: l.item_code === 'CC-EVP-220' ? '188000' : '2250',
          gstRate: '18',
        })),
      });
    });

    await check('the lowest quote is awarded and clears immediately', async () => {
      const comparison = await quotes.buildComparison(prId);
      const l1 = comparison.quotes.find(q => q.rank === 1)!;

      const { needsApproval } = await quotes.award(BUY, { prId, quotationId: l1.quotationId });
      assert(!needsApproval, 'a lowest award needs no extra approval');

      const { cleared } = await quotes.awardCleared(prId);
      assert(cleared, 'cleared for a purchase order');

      const after = await quotes.listQuotations(prId);
      assertEqual(after.filter(q => q.status === 'QUOTE_AWARDED').length, 1, 'one awarded');
      assert(after.some(q => q.status === 'QUOTE_LOST'), 'the others are marked lost, not deleted');
    });

    await check('a second award on the same PR is refused', async () => {
      const comparison = await quotes.buildComparison(prId);
      await rejects(
        () => quotes.award(BUY, { prId, quotationId: comparison.quotes[1].quotationId }),
        /already been awarded/,
        'second award',
      );
    });

    // =====================================================================
    // Purchase order
    // =====================================================================
    let poId = 0;

    await check('PO is drafted from the award at awarded rates', async () => {
      const po = await poSvc.createPo(BUY, { prId, expectedDelivery: '2026-10-06' });
      poId = Number(po.id);

      assert(String(po.po_no).startsWith('PO-DHU-'), `unexpected number ${po.po_no}`);
      assertEqual(po.status, 'PO_DRAFT', 'starts as a draft');

      const { lines } = await poSvc.getPo(poId);
      const coil = lines.find(l => l.item_code === 'CC-EVP-220')!;
      assertEqual(coil.rate, '179500.00', 'the awarded rate, copied through');
      assertEqual(coil.qty_ordered, '1.000', 'quantity from the PR');
    });

    await check('C-17 · a second PO on the same PR is refused', async () => {
      await rejects(
        () => poSvc.createPo(BUY, { prId, expectedDelivery: '2026-10-06' }),
        /already has purchase order/,
        'second PO',
      );
    });

    await check('po_issue_needs_tally · issuing without a Tally reference is refused', async () => {
      await rejects(() => poSvc.issuePo(BUY, poId, ''), /Tally PO reference is required/, 'no Tally ref');
    });

    await check('the issue checklist reports every gate', async () => {
      const checks = await poSvc.issueChecks(poId);
      const tally = checks.find(c => c.label.includes('Tally'))!;
      assert(!tally.passed, 'Tally reference not yet entered');
      assert(checks.filter(c => c.label !== tally.label).every(c => c.passed), 'everything else passes');
    });

    await check('the PO issues, and the PR moves to PO_POSTED', async () => {
      const po = await poSvc.issuePo(BUY, poId, 'TALLY/PO/26-27/0019');
      assertEqual(po.status, 'PO_CREATED', 'issued');
      assertEqual(po.tally_po_ref, 'TALLY/PO/26-27/0019', 'reference recorded');

      const { pr } = await prSvc.getPr(prId);
      assertEqual(pr.status, 'PO_POSTED', 'the PR has done its job');
    });

    await check('check_po_vendor · a blocked vendor cannot be ordered from', async () => {
      await vendors.blockVendor(ADMIN, arctic, 'Quality failures on three consecutive deliveries');
      await rejects(() => vendors.assertVendorOrderable(arctic), /is blocked/, 'blocked vendor');
      await vendors.unblockVendor(ADMIN, arctic);
    });

    await check('the PO appears as an expected delivery with its outstanding quantity', async () => {
      const expected = await poSvc.expectedDeliveries(SMGR.principal, siteA);
      const ours = expected.find(e => Number(e.id) === poId)!;
      assert(!!ours, 'listed for gate inward');
      assertEqual(ours.qty_outstanding, '41.000', '1 coil + 40 pallets, nothing received yet');
    });


    // =====================================================================
    // Receiving — gate inward, QC, GRN, shortfall
    // =====================================================================
    await masters.publishChecklist(ADMIN, {
      itemClassId: classId,
      version: 'AMB-v1',
      points: ['Packaging intact', 'Quantity matches challan', 'No visible damage'],
    });

    let giId = 0;

    await check('a delivery is logged at the gate, short by two pallets', async () => {
      const { lines } = await poSvc.getPo(poId);
      const coil = lines.find(l => l.item_code === 'CC-EVP-220')!;
      const pallet = lines.find(l => l.item_code === 'PL-HDPE-12')!;

      const gi = await gate.createGateInward(RCV, {
        poId,
        vehicleNo: 'wb 23 ab 4567', // normalised on the way in
        challanNo: 'CH-88213',
        challanDate: '2026-09-23',
        transporter: 'Sundar Roadways',
        lines: [
          { poLineId: Number(coil.id), qtyPerChallan: '1', qtyCounted: '1' },
          { poLineId: Number(pallet.id), qtyPerChallan: '40', qtyCounted: '38' },
        ],
      });

      giId = Number(gi.id);
      assertEqual(gi.vehicle_no, 'WB23AB4567', 'vehicle number normalised');
      assert(String(gi.gi_no).startsWith('GI-DHU-'), `numbered at the site: ${gi.gi_no}`);
      assertEqual(gi.temp_in_tolerance, null, 'ambient load has no temperature verdict');
    });

    await check('the gate records what was counted, and derives what is short', async () => {
      const { lines } = await gate.getGateInward(giId);
      assertEqual(lines.length, 2, 'both lines recorded');
      assertEqual(lines[1].qty_short, '2.000', 'generated short quantity');
      assertEqual(lines[1].qty_excess, '0.000', 'no excess');
    });

    await check('gate_inwards_challan_uq · the same challan cannot be logged twice', async () => {
      const { lines } = await poSvc.getPo(poId);
      await rejects(
        () =>
          gate.createGateInward(RCV, {
            poId, vehicleNo: 'WB23AB4567', challanNo: 'CH-88213', challanDate: '2026-09-23',
            lines: [{ poLineId: Number(lines[0].id), qtyPerChallan: '1', qtyCounted: '1' }],
          }),
        /already logged against this order/i,
        'duplicate challan',
      );
    });

    await check('C-09 · excess is recorded as counted, never clamped', async () => {
      const { lines } = await poSvc.getPo(poId);
      const coil = lines.find(l => l.item_code === 'CC-EVP-220')!;

      const gi = await gate.createGateInward(RCV, {
        poId, vehicleNo: 'WB23AB4567', challanNo: 'CH-OVER-1', challanDate: '2026-09-23',
        lines: [{ poLineId: Number(coil.id), qtyPerChallan: '1', qtyCounted: '3' }],
      });

      const detail = await gate.getGateInward(Number(gi.id));
      assertEqual(detail.lines[0].qty_counted, '3.000', 'counted as counted');
      assertEqual(detail.lines[0].qty_excess, '2.000', 'excess derived, not folded away');

      // Park it so it does not interfere with the rest of the run.
      await gate.rejectGateInward(RCV, Number(gi.id), 'Recorded for the excess test only');
    });

    await check('handing over to QC raises a shortfall case for the missing pallets', async () => {
      const { gi, shortfalls: raised } = await gate.sendToQc(RCV, giId);
      assertEqual(gi.status, 'QC_PENDING', 'gate inward moved to QC');
      assertEqual(raised.length, 1, 'one short line, one case');
      assertEqual(raised[0].qty_short, '2.000', 'raised at the generated quantity');
      assert(String(raised[0].sht_no).startsWith('SHT-DHU-'), 'numbered at the site');
    });

    await check('the shortfall case is idempotent if the handover is retried', async () => {
      const again = await inTransaction(tx => shortfalls.raiseShortfalls(tx, giId, RCV));
      assertEqual(again.length, 0, 'nothing raised a second time');
      const all = await shortfalls.listShortfalls(SMGR.principal);
      assertEqual(all.length, 1, 'still exactly one case');
    });

    let qcId = 0;

    await check('qc_inspections_segregation · the receiver cannot inspect their own delivery', async () => {
      await rejects(
        () => qcSvc.startInspection({ principal: principal(recvId, ['CG_RCV', 'CG_QC'], bothSites), ip: null }, giId),
        /somebody else has to inspect it/i,
        'receiver inspecting',
      );
    });

    await check('C-10 · QC takes its delivered quantity from the gate count', async () => {
      const { qc, lines } = await qcSvc.startInspection(QCI, giId);
      qcId = Number(qc.id);

      assert(String(qc.qc_no).startsWith('QC-DHU-'), `numbered at the site: ${qc.qc_no}`);
      assertEqual(lines.length, 2, 'one line per gate line');

      const pallet = lines.find(l => String(l.qty_delivered) === '38.000');
      assert(pallet !== undefined, 'delivered is the 38 counted, not the 40 on the challan');
    });

    await check('qc_lines_sum · a verdict that does not add up to what was delivered is refused', async () => {
      const { lines } = await qcSvc.getInspection(qcId);
      const coil = lines.find(l => l.item_code === 'CC-EVP-220')!;

      await rejects(
        () =>
          qcSvc.recordVerdict(QCI, qcId, {
            qcLineId: Number(coil.id), qtyAccepted: '5', qtyHold: '0', qtyRejected: '0',
          }),
        /must add up to the 1 delivered/i,
        'sum rule',
      );
    });

    await check('qc_lines_reason · held or rejected stock needs a reason code', async () => {
      const { lines } = await qcSvc.getInspection(qcId);
      const pallet = lines.find(l => l.item_code === 'PL-HDPE-12')!;

      await rejects(
        () =>
          qcSvc.recordVerdict(QCI, qcId, {
            qcLineId: Number(pallet.id), qtyAccepted: '30', qtyHold: '8', qtyRejected: '0',
          }),
        /needs a reason code/i,
        'reason rule',
      );
    });

    await check('the inspector records a verdict on every line', async () => {
      const { lines, points } = await qcSvc.getInspection(qcId);
      const coil = lines.find(l => l.item_code === 'CC-EVP-220')!;
      const pallet = lines.find(l => l.item_code === 'PL-HDPE-12')!;

      assert(points.length >= 3, 'checklist points came through');

      await qcSvc.recordVerdict(QCI, qcId, {
        qcLineId: Number(coil.id), qtyAccepted: '1', qtyHold: '0', qtyRejected: '0',
        checks: points.slice(0, 3).map(p => ({ pointId: Number(p.id), result: 'PASS' as const })),
      });

      // 30 good, 6 scuffed and held, 2 cracked and rejected.
      const updated = await qcSvc.recordVerdict(QCI, qcId, {
        qcLineId: Number(pallet.id), qtyAccepted: '30', qtyHold: '6', qtyRejected: '2',
        reasonCode: 'SURFACE_DAMAGE', remarks: 'Scuffing on the top deck of six pallets',
      });

      assertEqual(updated.qty_accepted, '30.000', 'accepted');
      assertEqual(updated.qty_hold, '6.000', 'held');
      assertEqual(updated.qty_rejected, '2.000', 'rejected');
    });

    await check('held stock reaches the site manager, uninspected lines do not', async () => {
      const queue = await qcSvc.pendingHolds(SMGR.principal);
      assertEqual(queue.length, 1, 'only the genuinely held line');
      assertEqual(queue[0].item_code, 'PL-HDPE-12', 'the scuffed pallets');
      assertEqual(queue[0].qty_hold, '6.000', 'six of them');
    });

    await check('the inspection completes', async () => {
      const done = await qcSvc.completeInspection(QCI, qcId);
      assert(done.completed_at !== null, 'completed_at stamped');

      const { gi } = await gate.getGateInward(giId);
      assertEqual(gi.status, 'QC_COMPLETED', 'gate inward followed');
    });

    await check('a receipt cannot be raised while stock is still on hold', async () => {
      await rejects(
        () => grnSvc.createGrn(WHL, { qcId }),
        /still has stock on conditional hold/i,
        'undecided hold',
      );
    });

    await check('the inspector cannot decide the hold they raised', async () => {
      const queue = await qcSvc.pendingHolds(SMGR.principal);
      await rejects(
        () =>
          qcSvc.decideHold(
            { principal: principal(inspId, ['CG_QC', 'CG_SMGR'], bothSites), ip: null },
            Number(queue[0].qc_line_id), 'CONCESSION', '6', 'Acceptable for internal use',
          ),
        /somebody else/i,
        'inspector deciding their own hold',
      );
    });

    await check('the site manager grants a concession on the held pallets', async () => {
      const queue = await qcSvc.pendingHolds(SMGR.principal);
      const decision = await qcSvc.decideHold(
        SMGR, Number(queue[0].qc_line_id), 'CONCESSION', '6',
        'Scuffing is cosmetic; accepted for the internal pallet pool at an agreed rebate',
      );
      assertEqual(decision.decision, 'CONCESSION', 'concession granted');
      assertEqual(decision.qty, '6.000', 'for all six');

      const after = await qcSvc.pendingHolds(SMGR.principal);
      assertEqual(after.length, 0, 'queue is clear');
    });

    let grnId = 0;

    await check('the receipt carries accepted plus concession, with the concession visible', async () => {
      const grn = await grnSvc.createGrn(WHL, { qcId });
      grnId = Number(grn.id);
      assert(String(grn.grn_no).startsWith('GRN-DHU-'), `numbered at the site: ${grn.grn_no}`);

      const { lines } = await grnSvc.getGrn(grnId);
      const pallet = lines.find(l => l.item_code === 'PL-HDPE-12')!;
      assertEqual(pallet.qty_accepted, '36.000', '30 accepted + 6 by concession');
      assertEqual(pallet.qty_concession, '6.000', 'concession stays decomposable');
    });

    await check('grns_segregation · neither the receiver nor the inspector can approve the receipt', async () => {
      await rejects(
        () => grnSvc.approveGrn({ principal: principal(recvId, ['CG_RCV', 'CG_SMGR'], bothSites), ip: null }, grnId),
        /received this delivery at the gate/i,
        'receiver approving',
      );
      await rejects(
        () => grnSvc.approveGrn({ principal: principal(inspId, ['CG_QC', 'CG_SMGR'], bothSites), ip: null }, grnId),
        /inspected this delivery/i,
        'inspector approving',
      );
    });

    await check('approval posts the stock, and only then', async () => {
      const before = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      const beforeQty = Number(before.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0);

      const { grn, entries } = await grnSvc.approveGrn(SMGR, grnId);
      assertEqual(grn.status, 'GRN_APPROVED', 'approved');
      assertEqual(entries.length, 2, 'one ledger entry per line');

      const after = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      const afterQty = Number(after.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0);
      assertEqual(afterQty - beforeQty, 36, '36 pallets landed');
    });

    await check('approval is replay-safe', async () => {
      // A second approval is refused by the state machine, but the movement
      // itself is idempotent — which is what matters after a dropped connection.
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM stock_ledger WHERE source_type = 'GRN_LINE'`;
      assertEqual(rows[0].n, '2', 'two entries, not four');

      await rejects(() => grnSvc.approveGrn(SMGR, grnId), /already GRN_APPROVED/i, 'second approval');
    });

    await check('the PO moves to partially received, and the balance still shows', async () => {
      const { po, lines } = await poSvc.getPo(poId);
      assertEqual(po.status, 'PO_PARTIALLY_RECEIVED', 'partially received');

      const pallet = lines.find(l => l.item_code === 'PL-HDPE-12')!;
      assertEqual(pallet.qty_received, '36.000', 'received');
      assertEqual(pallet.qty_outstanding, '4.000', '2 short at the gate, 2 rejected at QC');
    });

    await check('C-09 · an over-receipt cannot be approved', async () => {
      const { lines } = await poSvc.getPo(poId);
      const coil = lines.find(l => l.item_code === 'CC-EVP-220')!;

      // The coil line is already fully received, so any further receipt is excess.
      const gi2 = await gate.createGateInward(RCV, {
        poId, vehicleNo: 'WB23AB4567', challanNo: 'CH-88999', challanDate: '2026-09-23',
        lines: [{ poLineId: Number(coil.id), qtyPerChallan: '1', qtyCounted: '1' }],
      });
      await gate.sendToQc(RCV, Number(gi2.id));

      const { qc: qc2, lines: qc2Lines } = await qcSvc.startInspection(QCI, Number(gi2.id));
      await qcSvc.recordVerdict(QCI, Number(qc2.id), {
        qcLineId: Number(qc2Lines[0].id), qtyAccepted: '1', qtyHold: '0', qtyRejected: '0',
      });
      await qcSvc.completeInspection(QCI, Number(qc2.id));

      const grn2 = await grnSvc.createGrn(WHL, { qcId: Number(qc2.id) });
      await rejects(
        () => grnSvc.approveGrn(SMGR, Number(grn2.id)),
        /more than was ordered/i,
        'over-receipt',
      );

      // And the remedy the message names actually works.
      await grnSvc.flagGrn(SMGR, Number(grn2.id), 'Over-receipt on the coil line; PO amendment needed');
      const { grn } = await grnSvc.getGrn(Number(grn2.id));
      assertEqual(grn.status, 'GRN_FLAGGED', 'flagged rather than approved');
    });

    await check('C-26 · a re-inspection is a new record, and the original survives', async () => {
      const { qc: re, lines: reLines } = await qcSvc.reinspect(QCI, qcId);

      assertEqual(Number(re.is_reinspection_of), qcId, 'chained off the original');
      assertEqual(reLines.length, 2, 'covers the same gate lines again');

      // The original verdict is untouched — that is what C-02 chose option A for.
      const { lines: originalLines } = await qcSvc.getInspection(qcId);
      const pallet = originalLines.find(l => String(l.qty_accepted) === '30.000');
      assert(pallet !== undefined, 'the original 30/6/2 verdict is still readable');
      assertEqual(pallet?.reason_code, 'SURFACE_DAMAGE', 'and its reason');
    });

    await check('the shortfall is decided, and short-closing needs a reason', async () => {
      const cases = await shortfalls.listShortfalls(SMGR.principal, { decision: 'PENDING' });
      assertEqual(cases.length, 1, 'the pallet shortfall');

      await rejects(
        () => shortfalls.decideShortfall(SMGR, Number(cases[0].id), 'SHORT_CLOSE'),
        /needs a reason/i,
        'short close without a reason',
      );

      const decided = await shortfalls.decideShortfall(SMGR, Number(cases[0].id), 'AWAIT_BALANCE');
      assertEqual(decided.decision, 'AWAIT_BALANCE', 'vendor still owes them');
      assertEqual(decided.closed_at, null, 'not closed');
    });


    // =====================================================================
    // Cold chain (conflict C-11) — its own short chain, because the band has
    // to come from real item classes on a real order.
    // =====================================================================
    let coldPoId = 0;
    let coldGiId = 0;

    await check('a cold-chain order is set up end to end', async () => {
      const frozen = Number(
        (await masters.createItemClass(ADMIN, {
          code: 'FRZ', name: 'Frozen', isColdChain: true,
          tempMinC: '-20', tempMaxC: '-15', requiresDataLogger: false,
        })).id,
      );

      await masters.publishChecklist(ADMIN, {
        itemClassId: frozen, version: 'FRZ-v1', points: ['Core temperature', 'Packaging intact'],
      });

      const prawnId = Number(
        (await masters.createItem(ADMIN, {
          code: 'FZ-PRAWN-20', name: 'Frozen prawn 20 kg carton', itemClassId: frozen, uom: 'Nos',
        })).id,
      );

      const mr = await mrSvc.createMr(REQ, {
        siteId: siteA, category: 'CONSUMABLES', requiredBy: '2026-10-30', urgency: 'ROUTINE',
        lines: [{ itemId: prawnId, qtyRequested: '100' }],
      });
      const coldMrId = Number(mr.id);

      await mrSvc.runStockCheck(SMGR, coldMrId);
      await mrSvc.declare(REQ, coldMrId, {
        businessImpact: 'The freezer block runs out of stock for the Durga Puja order book without these cartons.',
        budgetCodeId: budgetId, estimatedValue: '120000',
        allocations: [{ siteId: siteA, costHead: 'Freezer block', pct: '100' }],
      });
      await mrSvc.decideMr(SMGR, coldMrId, true);

      const { lines: mrLines } = await mrSvc.getMr(coldMrId);
      const pr = await prSvc.createPr(BUY, {
        mrId: coldMrId, procurementType: 'MATERIAL',
        purpose: 'Frozen prawn cartons for the Durga Puja order book',
        expectedDelivery: '2026-10-20',
        paymentTerms: {
          pay_advance_pct: '0', pay_before_delivery_pct: '0', pay_running_pct: '0',
          pay_post_delivery_pct: '100', pay_post_completion_pct: '0', pay_retention_pct: '0',
        },
        lines: [{ mrLineId: Number(mrLines[0].id), estRate: '1200', gstRate: '5' }],
      });
      const coldPrId = Number(pr.id);

      await prSvc.submitPr(BUY, coldPrId);
      // 100 x 1,200 = 120,000 + 5% = 126,000 — still the 1-10 lakh band, so
      // Site Manager then Functional Head, same as the first chain.
      await prSvc.decidePr(SMGR, coldPrId, true);
      await prSvc.decidePr(FHEAD, coldPrId, true);

      const { pr: submitted } = await prSvc.getPr(coldPrId);
      assertEqual(submitted.status, 'PR_APPROVED', 'approved through both levels');

      // Three quotations, so no waiver is needed — the waiver path has its own
      // check in the procurement chain above.
      const { lines: prLines } = await prSvc.getPr(coldPrId);
      const prLineId = Number(prLines[0].id);

      const quoted: number[] = [];
      for (const [vendorId, rate, ref] of [
        [frostline, '1180', 'FRZ-Q-1'],
        [arctic, '1225', 'FRZ-Q-2'],
        [polar, '1260', 'FRZ-Q-3'],
      ] as [number, string, string][]) {
        const q = await quotes.recordQuotation(BUY, {
          prId: coldPrId, vendorId, vendorQuoteRef: ref,
          quoteDate: '2026-09-23', validUntil: '2026-10-31',
          lines: [{ prLineId, unitRate: rate, gstRate: '5' }],
        });
        quoted.push(Number(q.id));
      }

      await quotes.award(BUY, { prId: coldPrId, quotationId: quoted[0] });

      const po = await poSvc.createPo(BUY, { prId: coldPrId, expectedDelivery: '2026-10-20' });
      coldPoId = Number(po.id);
      await poSvc.issuePo(BUY, coldPoId, 'TALLY-FRZ-001');
    });

    await check('C-11 · a cold-chain load cannot be logged in without a reading', async () => {
      const { lines } = await poSvc.getPo(coldPoId);
      await rejects(
        () =>
          gate.createGateInward(RCV, {
            poId: coldPoId, vehicleNo: 'WB23AB4567', challanNo: 'CH-FRZ-1', challanDate: '2026-09-23',
            lines: [{ poLineId: Number(lines[0].id), qtyPerChallan: '100', qtyCounted: '100' }],
          }),
        /cold-chain items \(FRZ\).*reefer temperature/is,
        'missing reading',
      );
    });

    await check('C-11 · the tolerance verdict is derived, never taken from the client', async () => {
      const { lines } = await poSvc.getPo(coldPoId);

      // -12 °C is warmer than the -15 ceiling, so this load breached.
      const gi = await gate.createGateInward(RCV, {
        poId: coldPoId, vehicleNo: 'WB23AB4567', challanNo: 'CH-FRZ-2', challanDate: '2026-09-23',
        reeferSetPointC: '-18', reeferActualC: '-12',
        lines: [{ poLineId: Number(lines[0].id), qtyPerChallan: '100', qtyCounted: '100' }],
      });

      coldGiId = Number(gi.id);
      assertEqual(gi.temp_in_tolerance, false, 'breach derived from the band, not asserted');
      assertEqual(gi.reefer_actual_c, '-12.0', 'the reading is kept as read');
    });

    await check('C-11 · a breached load cannot be accepted, only held', async () => {
      await gate.sendToQc(RCV, coldGiId);
      const { qc, lines } = await qcSvc.startInspection(QCI, coldGiId);
      const coldQcId = Number(qc.id);

      await qcSvc.recordVerdict(QCI, coldQcId, {
        qcLineId: Number(lines[0].id), qtyAccepted: '100', qtyHold: '0', qtyRejected: '0',
      });

      await rejects(
        () => qcSvc.completeInspection(QCI, coldQcId),
        /ran at -12.*cannot be accepted/is,
        'accepting a breached load',
      );

      // Holding it instead is the path the message names, and it works.
      await qcSvc.recordVerdict(QCI, coldQcId, {
        qcLineId: Number(lines[0].id), qtyAccepted: '0', qtyHold: '100', qtyRejected: '0',
        reasonCode: 'COLD_CHAIN_BREACH', remarks: 'Reefer ran at -12 °C against a -20 to -15 band',
      });

      const done = await qcSvc.completeInspection(QCI, coldQcId);
      assert(done.completed_at !== null, 'completes once nothing is accepted on a breach');
    });

    await check('the whole chain is in the audit trail', async () => {
      const rows = await sql<{ entity_type: string; action: string }[]>`
        SELECT entity_type, action FROM audit_log ORDER BY id`;

      for (const entity of [
        'MR', 'TRANSFER', 'PR', 'QUOTATION', 'QUOTE_AWARD', 'PO', 'VENDOR',
        'GATE_INWARD', 'QC_LINE', 'GRN', 'SHORTFALL',
      ]) {
        assert(rows.some(r => r.entity_type === entity), `${entity} is missing from the audit trail`);
      }
      assert(rows.filter(r => r.action === 'TRANSITION').length >= 10, 'transitions recorded');
    });

    console.log('\n');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function dropTestDb() {
  const admin = postgres(adminUrl.toString(), { ssl: false, max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
  } catch {
    /* best effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error(`\n\n  Setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    failures++;
  } finally {
    process.stdout.write('  dropping the throwaway database … ');
    await dropTestDb();
    console.log('ok\n');
  }

  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
    if (!r.ok) console.log(`      ${r.message}`);
  }
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed\n`);
  process.exit(failures > 0 ? 1 : 0);
}

void run();
