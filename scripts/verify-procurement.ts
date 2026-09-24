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
  const inventory = await import('../lib/services/inventory');
  const issues = await import('../lib/services/issues');
  const assets = await import('../lib/services/assets');
  const damage = await import('../lib/services/damage');
  const rtv = await import('../lib/services/rtv');
  const invoices = await import('../lib/services/invoices');
  const debitNotes = await import('../lib/services/debit-notes');
  const recon = await import('../lib/services/reconciliation');
  const accountsLedger = await import('../lib/services/ledger-accounts');
  const dash = await import('../lib/services/dashboard');
  const auditView = await import('../lib/services/audit-trail');
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
    const acctId = await mkUser('acc', 'Anita Accounts');
    const ware2Id = await mkUser('whl2', 'Wahida Warehouse Lead');

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
    const ACC = { principal: principal(acctId, ['CG_ACC'], bothSites), ip: null };
    const WHL2 = { principal: principal(ware2Id, ['CG_WHL'], bothSites), ip: null };

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


    /**
     * Run the whole chain for one item and return the approved receipt.
     *
     * Every step is proven above; this exists so a test that needs stock ON THE
     * SHELF can say so without repeating sixty lines of setup.
     */
    const buildReceipt = async (spec: {
      itemId: number; itemCode: string; qty: string; rate: string;
    }): Promise<{ grnId: number; poId: number }> => {
      const mr = await mrSvc.createMr(REQ, {
        siteId: siteA, category: 'CONSUMABLES', requiredBy: '2026-11-30', urgency: 'ROUTINE',
        lines: [{ itemId: spec.itemId, qtyRequested: spec.qty }],
      });
      const id = Number(mr.id);

      await mrSvc.runStockCheck(SMGR, id);
      await mrSvc.declare(REQ, id, {
        businessImpact: `Operations need ${spec.itemCode} on site and the group holds none to transfer.`,
        budgetCodeId: budgetId, estimatedValue: '10000',
        allocations: [{ siteId: siteA, costHead: 'Warehouse', pct: '100' }],
      });
      await mrSvc.decideMr(SMGR, id, true);

      const { lines: mrLines } = await mrSvc.getMr(id);
      const pr = await prSvc.createPr(BUY, {
        mrId: id, procurementType: 'MATERIAL',
        purpose: `Purchase of ${spec.itemCode} for warehouse operations`,
        expectedDelivery: '2026-11-20',
        paymentTerms: {
          pay_advance_pct: '0', pay_before_delivery_pct: '0', pay_running_pct: '0',
          pay_post_delivery_pct: '100', pay_post_completion_pct: '0', pay_retention_pct: '0',
        },
        lines: [{ mrLineId: Number(mrLines[0].id), estRate: spec.rate, gstRate: '18' }],
      });
      const prId2 = Number(pr.id);

      await prSvc.submitPr(BUY, prId2);
      const state = await prSvc.prApprovalState(prId2);
      for (const level of state.levels) {
        await prSvc.decidePr(level.required_role === 'CG_FHEAD' ? FHEAD : SMGR, prId2, true);
      }

      const { lines: prLines } = await prSvc.getPr(prId2);
      const quoted: number[] = [];
      for (const [vendorId, bump, ref] of [
        [frostline, 0, 'A'], [arctic, 50, 'B'], [polar, 90, 'C'],
      ] as [number, number, string][]) {
        const q = await quotes.recordQuotation(BUY, {
          prId: prId2, vendorId, vendorQuoteRef: `${spec.itemCode}-${ref}`,
          quoteDate: '2026-09-23', validUntil: '2026-12-31',
          lines: [{ prLineId: Number(prLines[0].id), unitRate: String(Number(spec.rate) + bump), gstRate: '18' }],
        });
        quoted.push(Number(q.id));
      }
      await quotes.award(BUY, { prId: prId2, quotationId: quoted[0] });

      const po = await poSvc.createPo(BUY, { prId: prId2, expectedDelivery: '2026-11-20' });
      const poId2 = Number(po.id);
      await poSvc.issuePo(BUY, poId2, `TALLY-${spec.itemCode}`);

      const { lines: poLines } = await poSvc.getPo(poId2);
      const gi = await gate.createGateInward(RCV, {
        poId: poId2, vehicleNo: 'WB23AB4567', challanNo: `CH-${spec.itemCode}`,
        challanDate: '2026-09-23',
        lines: [{ poLineId: Number(poLines[0].id), qtyPerChallan: spec.qty, qtyCounted: spec.qty }],
      });
      await gate.sendToQc(RCV, Number(gi.id));

      const { qc, lines: qcLines } = await qcSvc.startInspection(QCI, Number(gi.id));
      await qcSvc.recordVerdict(QCI, Number(qc.id), {
        qcLineId: Number(qcLines[0].id), qtyAccepted: spec.qty, qtyHold: '0', qtyRejected: '0',
      });
      await qcSvc.completeInspection(QCI, Number(qc.id));

      const grn = await grnSvc.createGrn(WHL, { qcId: Number(qc.id) });
      await grnSvc.approveGrn(SMGR, Number(grn.id));

      return { grnId: Number(grn.id), poId: poId2 };
    };


    // =====================================================================
    // Inventory — position, issues, adjustment, reversal, assets, damage
    // =====================================================================
    await check('C-21 · the stock position is read one site at a time', async () => {
      const rows = await inventory.stockPosition(SMGR.principal, { siteId: siteA });
      const pallet = rows.find(r => r.code === 'PL-HDPE-12');
      assert(pallet !== undefined, 'the pallets are on the Dhulagarh position');
      // 60 arrived by transfer, 36 by goods receipt.
      assertEqual(pallet?.available, '96.000', 'available');
      assertEqual(pallet?.reorder_level, '0', 'no reorder level set here');

      // The cross join invents a row for every item at every site; an item that
      // has never been here has nothing to show.
      assert(
        !rows.some(r => r.code === 'FZ-PRAWN-20'),
        'an item with no stock and no reorder level is not listed',
      );
    });

    await check('a site the caller does not hold is refused', async () => {
      const elsewhere = { principal: principal(managerId, ['CG_SMGR'], [bothSites[1]]), ip: null };
      await rejects(
        () => inventory.stockPosition(elsewhere.principal, { siteId: siteA }),
        /do not have access to that site/i,
        'cross-site read',
      );
    });

    let issueId = 0;

    await check('stock is issued, and the ledger records it', async () => {
      const { issue, lines } = await issues.createIssue(WHL, {
        siteId: siteA,
        issuedTo: 'Freezer block maintenance, WO-4471',
        lines: [{ itemId: palletId, qty: '6' }],
      });

      issueId = Number(issue.id);
      assert(String(issue.issue_no).startsWith('ISS-DHU-'), `numbered at the site: ${issue.issue_no}`);
      assertEqual(lines.length, 1, 'one line');

      const balances = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      assertEqual(balances.find(b => b.bucket === 'AVAILABLE')?.qty, '90.000', '96 less 6');
    });

    await check('an issue larger than the balance is refused, naming what is there', async () => {
      await rejects(
        () =>
          issues.createIssue(WHL, {
            siteId: siteA, issuedTo: 'Overreach test',
            lines: [{ itemId: palletId, qty: '500' }],
          }),
        /has 90 Nos of HDPE pallet.*not enough to issue 500/is,
        'overdraw',
      );
    });

    await check('nothing is issued when a later line cannot be met', async () => {
      const before = await inTransaction(tx => stock.balancesFor(tx, siteA, coilId));
      const beforeQty = Number(before.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0);

      await rejects(
        () =>
          issues.createIssue(WHL, {
            siteId: siteA, issuedTo: 'Partial test',
            lines: [
              { itemId: coilId, qty: '1' },
              { itemId: palletId, qty: '9999' },
            ],
          }),
        /not enough to issue/i,
        'atomicity',
      );

      const after = await inTransaction(tx => stock.balancesFor(tx, siteA, coilId));
      const afterQty = Number(after.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0);
      assertEqual(afterQty, beforeQty, 'the first line was not issued either');
    });

    await check('the same item twice on one issue is refused', async () => {
      await rejects(
        () =>
          issues.createIssue(WHL, {
            siteId: siteA, issuedTo: 'Duplicate test',
            lines: [
              { itemId: palletId, qty: '1' },
              { itemId: palletId, qty: '2' },
            ],
          }),
        /more than one line/i,
        'duplicate item',
      );
    });

    await check('only the Warehouse Lead may issue', async () => {
      await rejects(
        () =>
          issues.createIssue(REQ, {
            siteId: siteA, issuedTo: 'Not my job',
            lines: [{ itemId: palletId, qty: '1' }],
          }),
        /Warehouse Lead/i,
        'permission',
      );
    });

    let adjEntryId = 0;

    await check('C-27 · an adjustment has a source record, and two are not one', async () => {
      const first = await inventory.adjustToCount(WHL, {
        siteId: siteA, itemId: palletId, countedQty: '88',
        reason: 'Quarterly stock take, aisle 3 — two pallets unaccounted for',
      });

      assert(first.adjustment !== null, 'the stock take is recorded');
      assertEqual(first.delta, '-2.000', 'down two');
      assert(String(first.adjustment?.adj_no).startsWith('ADJ-DHU-'), 'numbered at the site');
      adjEntryId = Number(first.entryId);

      // The second count MUST post. Under any (site, item) key scheme it would
      // collide with the first and silently do nothing — which is the whole
      // reason C-27 exists.
      const second = await inventory.adjustToCount(WHL, {
        siteId: siteA, itemId: palletId, countedQty: '87',
        reason: 'Recount after the aisle was tidied — one more missing',
      });

      assert(second.entryId !== null, 'the second count posted its own entry');
      assert(second.entryId !== first.entryId, 'and it is a different ledger entry');
      assertEqual(second.delta, '-1.000', 'down one more');

      const balances = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      assertEqual(balances.find(b => b.bucket === 'AVAILABLE')?.qty, '87.000', 'the count wins');
    });

    await check('a count that matches posts nothing at all', async () => {
      const same = await inventory.adjustToCount(WHL, {
        siteId: siteA, itemId: palletId, countedQty: '87',
        reason: 'Recount confirms the figure',
      });
      assertEqual(same.entryId, null, 'no ledger entry');
      assertEqual(same.adjustment, null, 'no adjustment record either');
    });

    await check('the ledger explains every movement through its source', async () => {
      const rows = await inventory.listAdjustments(SMGR.principal, { siteId: siteA });
      assertEqual(rows.length, 2, 'two discrepancies recorded');
      assert(rows.every(r => r.entry_no !== null), 'each resolves to its ledger entry');
      assertEqual(rows[0].delta, '-1.000', 'newest first');
    });

    await check('an adjustment cannot take stock below zero', async () => {
      await rejects(
        () =>
          inventory.adjustToCount(WHL, {
            siteId: siteA, itemId: coilId, countedQty: '-5',
            reason: 'Impossible count',
          }),
        /cannot be negative/i,
        'negative count',
      );
    });

    await check('§29 · a movement is corrected by reversal, never by editing', async () => {
      const before = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      const beforeQty = Number(before.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0);

      const reversalId = await inventory.reverseMovement(
        SMGR, adjEntryId, 'The first stock take counted a bay that belongs to Pune',
      );

      const after = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      const afterQty = Number(after.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0);
      assertEqual(afterQty - beforeQty, 2, 'the two pallets came back');

      // Both entries stand. That is the point of a reversal.
      const entry = await inventory.ledgerEntry(adjEntryId);
      assertEqual(Number(entry.reversed_by_id), reversalId, 'the original names its reversal');
    });

    await check('the same movement cannot be reversed twice', async () => {
      await rejects(
        () => inventory.reverseMovement(SMGR, adjEntryId, 'Second attempt'),
        /already been reversed/i,
        'double reversal',
      );
    });

    await check('a reversal is not itself reversible', async () => {
      const entries = await inventory.ledger(SMGR.principal, { siteId: siteA, movement: 'REVERSAL' });
      await rejects(
        () => inventory.reverseMovement(SMGR, Number(entries[0].id), 'Reversing the reversal'),
        /itself a reversal/i,
        'reversing a reversal',
      );
    });

    await check('only a Site Manager or Functional Head may reverse', async () => {
      await rejects(
        () => inventory.reverseMovement(WHL, adjEntryId, 'Not my call'),
        /do not have permission/i,
        'reversal permission',
      );
    });

    // =====================================================================
    // Serialised stock and the asset register (C-19)
    // =====================================================================
    let serialItemId = 0;
    let serialGrnId = 0;

    await check('a serialised item is received, and each unit enters the register', async () => {
      serialItemId = Number(
        (await masters.createItem(ADMIN, {
          code: 'DL-TEMP-01', name: 'Temperature data logger', itemClassId: classId,
          uom: 'Nos', isSerialised: true, warrantyMonths: 24,
        })).id,
      );

      // Straight to a receipt: the procurement chain is proven above, and what
      // is under test here is what happens to the units.
      const built = await buildReceipt({
        itemId: serialItemId, qty: '3', rate: '18000', itemCode: 'DL-TEMP-01',
      });
      serialGrnId = built.grnId;

      const units = await assets.listAssets(SMGR.principal, { itemId: serialItemId });
      assertEqual(units.length, 3, 'one row per unit');
      assertEqual(units[0].asset_tag, 'DL-TEMP-01-DHU-0001', 'tagged in an item-and-site series');
      assertEqual(units[2].asset_tag, 'DL-TEMP-01-DHU-0003', 'sequentially');
      assert(units.every(u => u.bucket === 'AVAILABLE'), 'and available');
      assert(units.every(u => u.in_warranty === true), 'under warranty from receipt');
    });

    await check('C-19 · the register and the balance agree after a receipt', async () => {
      const drift = await assets.assetDrift(siteA);
      assertEqual(drift, [], 'no drift');
    });

    await check('C-19 · issuing a serialised item moves its units too', async () => {
      await issues.createIssue(WHL, {
        siteId: siteA, issuedTo: 'Reefer 4 retrofit',
        lines: [{ itemId: serialItemId, qty: '1' }],
      });

      const units = await assets.listAssets(SMGR.principal, { itemId: serialItemId });
      const gone = units.filter(u => u.bucket === 'WRITTEN_OFF');
      assertEqual(gone.length, 1, 'one unit left the building');
      assertEqual(gone[0].asset_tag, 'DL-TEMP-01-DHU-0001', 'the oldest, deterministically');

      const available = units.filter(u => u.bucket === 'AVAILABLE');
      assertEqual(available.length, 2, 'two still on the shelf');

      const drift = await assets.assetDrift(siteA);
      assertEqual(drift, [], 'still no drift');
    });

    await check('a unit carries its receipt, and only its details are editable', async () => {
      const units = await assets.listAssets(SMGR.principal, { itemId: serialItemId, bucket: 'AVAILABLE' });
      const { asset, history } = await assets.getAsset(Number(units[0].id));

      assertEqual(asset.grn_no !== null, true, 'traceable to the receipt that created it');
      assert(Array.isArray(history), 'its movement history reads');

      const updated = await assets.updateAsset(WHL, Number(units[0].id), { serialNo: 'SN-99120-A' });
      assertEqual(updated.serial_no, 'SN-99120-A', 'serial recorded');
      assertEqual(updated.bucket, 'AVAILABLE', 'the bucket is not editable and did not move');
    });

    // =====================================================================
    // Damage and quarantine
    // =====================================================================
    let damageId = 0;

    await check('damage is reported, and the stock is quarantined in the same breath', async () => {
      const before = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      const beforeAvailable = Number(before.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0);

      const report = await damage.reportDamage(WHL, {
        siteId: siteA, itemId: palletId, qty: '4', cause: 'HANDLING',
        observedOn: '2026-09-23',
      });

      damageId = Number(report.id);
      assert(String(report.dmg_no).startsWith('DMG-DHU-'), `numbered at the site: ${report.dmg_no}`);
      assertEqual(report.status, 'DMG_REPORTED', 'reported');
      assert(report.quarantine_entry_id !== null, 'the quarantine movement is stamped on it');

      const after = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      assertEqual(
        Number(after.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0),
        beforeAvailable - 4,
        'out of the available pool immediately',
      );
      assertEqual(after.find(b => b.bucket === 'DAMAGED_HOLD')?.qty, '4.000', 'and into damaged hold');
    });

    await check('damage cannot be reported for more than is available', async () => {
      await rejects(
        () =>
          damage.reportDamage(WHL, {
            siteId: siteA, itemId: palletId, qty: '9999', cause: 'STORAGE_FAILURE',
            observedOn: '2026-09-23',
          }),
        /cannot be quarantined/i,
        'over-quarantine',
      );
    });

    await check('a serialised item is damaged as a unit, not as a quantity', async () => {
      await rejects(
        () =>
          damage.reportDamage(WHL, {
            siteId: siteA, itemId: serialItemId, qty: '1', cause: 'HANDLING',
            observedOn: '2026-09-23',
          }),
        /name the unit that was damaged/i,
        'serialised without a unit',
      );
    });

    await check('the reporter cannot sign the inspection they raised', async () => {
      await rejects(
        () =>
          damage.inspectDamage(
            { principal: principal(wareId, ['CG_WHL', 'CG_SMGR'], bothSites), ip: null },
            damageId, 'Looks broken to me, and I found it',
          ),
        /somebody else/i,
        'self-inspection',
      );
    });

    await check('the inspection needs both a Site Manager and a QC inspector', async () => {
      const first = await damage.inspectDamage(
        SMGR, damageId, 'Four pallets cracked across the top deck; consistent with forklift contact',
      );
      assert(!first.complete, 'one signature is not an inspection');
      assertEqual(first.report.status, 'DMG_REPORTED', 'still reported');

      // Signing again from the same person adds nothing and is refused while
      // the inspection is still open — the second signature has to be someone
      // else's, which is the entire point of a joint inspection.
      await rejects(
        () => damage.inspectDamage(SMGR, damageId, 'Signing again for good measure'),
        /already signed/i,
        'double signature',
      );

      const second = await damage.inspectDamage(
        QCI, damageId, 'Confirmed; load-bearing surface compromised, not repairable in house',
      );
      assert(second.complete, 'both roles have now signed');
      assertEqual(second.report.status, 'DMG_INSPECTED', 'and the report moved');
      assertEqual(second.signatures.length, 2, 'two signatures recorded');
    });

    await check('a completed inspection is not signed again', async () => {
      await rejects(
        () => damage.inspectDamage(SMGR, damageId, 'Late to the party'),
        /inspection is already done/i,
        'signing after completion',
      );
    });


    let coilDamageId = 0;
    let loggerDamageId = 0;
    let shortfallRtvId = 0;

    // =====================================================================
    // Returns — damage decisions, then the three RTV sources
    // =====================================================================
    await check('a repair is approved, and the stock comes back from it', async () => {
      // The pallet damage from above: 4 at ₹2,150 is ₹8,600, well under every
      // threshold, so it takes the single-approver route.
      const { report } = await damage.decideDamage(WHL, damageId, 'INTERNAL_REPAIR');
      assertEqual(report.status, 'DMG_DECISION_PENDING_APPROVAL', 'proposed');
      assertEqual(report.decision, 'INTERNAL_REPAIR', 'repair');

      const approved = await damage.approveDamageDecision(FHEAD, damageId);
      assertEqual(approved.report.status, 'DMG_UNDER_REPAIR', 'under repair');
      assert(approved.entryId !== null, 'and the stock moved with it');

      const mid = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      assertEqual(mid.find(b => b.bucket === 'UNDER_REPAIR')?.qty, '4.000', 'out of damaged hold');
      assertEqual(mid.find(b => b.bucket === 'DAMAGED_HOLD')?.qty, '0.000', 'and nothing left there');

      const done = await damage.completeRepair(WHL, damageId, 'Top decks re-plated');
      assertEqual(done.report.status, 'DMG_CLOSED', 'closed');

      const after = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      assertEqual(after.find(b => b.bucket === 'UNDER_REPAIR')?.qty, '0.000', 'repair bucket drained');
    });

    await check('C-13 · a write-off above ₹50,000 needs an insurance reference', async () => {
      const report = await damage.reportDamage(WHL, {
        siteId: siteA, itemId: coilId, qty: '1', cause: 'POWER_REFRIGERATION_FAILURE',
        observedOn: '2026-09-23',
      });
      coilDamageId = Number(report.id);

      await damage.inspectDamage(SMGR, coilDamageId, 'Compressor seized after the substation failure');
      await damage.inspectDamage(QCI, coilDamageId, 'Confirmed; windings burnt out, beyond economic repair');

      // The coil was received at ₹1,82,000, so this is well over the threshold.
      await rejects(
        () => damage.decideDamage(WHL, coilDamageId, 'WRITE_OFF'),
        /above the .50,000 threshold.*insurance claim reference/is,
        'no insurance reference',
      );
    });

    await check('the reporter cannot approve their own decision', async () => {
      await damage.decideDamage(WHL, coilDamageId, 'WRITE_OFF', {
        insuranceClaimRef: 'NIC/2026/CG/00817',
      });

      // Wasim raised it and holds CG_WHL, which IS level 1 of this band — so
      // the permission passes and only the self-approval rule stands in the way.
      await rejects(
        () => damage.approveDamageDecision(WHL, coilDamageId),
        /somebody else approves/i,
        'self-approval',
      );
    });

    await check('a write-off is banded, and destroys stock only once every level clears', async () => {
      const levels = await damage.writeOffApprovals(coilDamageId);
      // ₹1,82,000 falls in the ₹25,000–2 lakh band: Warehouse Lead, then
      // Functional Head.
      assertEqual(levels.map(l => l.required_role), ['CG_WHL', 'CG_FHEAD'], 'two levels');

      const first = await damage.approveDamageDecision(WHL2, coilDamageId);
      assert(!first.complete, 'one level is not approval');
      assertEqual(first.report.status, 'DMG_DECISION_PENDING_APPROVAL', 'still pending');

      const mid = await inTransaction(tx => stock.balancesFor(tx, siteA, coilId));
      assertEqual(mid.find(b => b.bucket === 'DAMAGED_HOLD')?.qty, '1.000', 'still only quarantined');

      const second = await damage.approveDamageDecision(FHEAD, coilDamageId);
      assert(second.complete, 'both levels cleared');
      assertEqual(second.report.status, 'DMG_WRITTEN_OFF', 'written off');

      const after = await inTransaction(tx => stock.balancesFor(tx, siteA, coilId));
      assertEqual(after.find(b => b.bucket === 'WRITTEN_OFF')?.qty, '1.000', 'and now it is gone');
      assertEqual(after.find(b => b.bucket === 'DAMAGED_HOLD')?.qty, '0.000', 'hold drained');
    });

    await check('a warranty claim is refused on stock that was out of warranty', async () => {
      // The pallets carry no warranty at all.
      const report = await damage.reportDamage(RCV, {
        siteId: siteA, itemId: palletId, qty: '2', cause: 'STORAGE_FAILURE',
        observedOn: '2026-09-23',
      });
      const id = Number(report.id);
      await damage.inspectDamage(SMGR, id, 'Water ingress on two pallets in the low bay');
      await damage.inspectDamage(QCI, id, 'Confirmed; swelling and delamination');

      await rejects(
        () => damage.decideDamage(WHL, id, 'WARRANTY_CLAIM'),
        /no warranty is recorded/i,
        'warranty claim without a warranty',
      );

      // ₹4,300 falls in the lowest band, which is one level — but that level is
      // still CG_WHL. A write-off is never unapproved, however small.
      await damage.decideDamage(WHL, id, 'WRITE_OFF');
      const done = await damage.approveDamageDecision(WHL2, id);
      assertEqual(done.report.status, 'DMG_WRITTEN_OFF', 'written off once its one level cleared');
    });

    // =====================================================================
    // RTV, all three sources
    // =====================================================================
    let damageRtvId = 0;

    await check('a warranty claim clears the way for a return, without moving stock yet', async () => {
      // The data logger: serialised, 24 months warranty, traceable to its receipt.
      const units = await assets.listAssets(SMGR.principal, { itemId: serialItemId, bucket: 'AVAILABLE' });
      const report = await damage.reportDamage(WHL, {
        siteId: siteA, itemId: serialItemId, qty: '1', cause: 'HANDLING',
        observedOn: '2026-09-23', assetUnitId: Number(units[0].id),
      });
      loggerDamageId = Number(report.id);
      assertEqual(report.in_warranty, true, 'in warranty when the damage was seen');

      await damage.inspectDamage(SMGR, loggerDamageId, 'Probe sheared off at the gland');
      await damage.inspectDamage(QCI, loggerDamageId, 'Confirmed; manufacturing defect at the joint');

      await damage.decideDamage(WHL, loggerDamageId, 'WARRANTY_CLAIM');
      const approved = await damage.approveDamageDecision(FHEAD, loggerDamageId);
      assertEqual(approved.report.status, 'DMG_RETURN_RAISED', 'cleared to return');
      assertEqual(approved.entryId, null, 'and no movement yet — it has not left the building');

      const balances = await inTransaction(tx => stock.balancesFor(tx, siteA, serialItemId));
      assertEqual(balances.find(b => b.bucket === 'DAMAGED_HOLD')?.qty, '1.000', 'still quarantined');
    });

    await check('the return picker offers every origin that has not been returned', async () => {
      const origins = await rtv.returnableOrigins(SMGR.principal);
      const sources = new Set(origins.map(o => String(o.source)));

      assert(sources.has('WAREHOUSE_DAMAGE'), 'the warranty-claim damage is offered');
      assert(sources.has('QC_REJECTION'), 'the rejected pallets are offered');
      assert(sources.has('SHORTFALL'), 'the awaited balance is offered');
    });

    await check('source · WAREHOUSE_DAMAGE takes the stock out of damaged hold', async () => {
      const created = await rtv.createRtv(WHL, {
        source: 'WAREHOUSE_DAMAGE', basis: 'FREE_REPLACEMENT', damageId: loggerDamageId,
      });
      damageRtvId = Number(created.id);
      assert(String(created.rtv_no).startsWith('RTV-DHU-'), `numbered at the site: ${created.rtv_no}`);
      assertEqual(created.status, 'RTV_DRAFT', 'draft');
      assertEqual(created.prn_no, null, 'no PRN until it is approved');

      const { rtv: approved } = await rtv.approveRtv(SMGR, damageRtvId);
      assertEqual(approved.status, 'RTV_APPROVED', 'approved');
      assert(String(approved.prn_no).startsWith('PRN-DHU-'), `PRN minted: ${approved.prn_no}`);
      assert(String(approved.gate_pass_no).startsWith('RGP-DHU-'), `gate pass minted: ${approved.gate_pass_no}`);

      const balances = await inTransaction(tx => stock.balancesFor(tx, siteA, serialItemId));
      assertEqual(balances.find(b => b.bucket === 'DAMAGED_HOLD')?.qty, '0.000', 'damaged hold drained');

      const { lines } = await rtv.getRtv(damageRtvId);
      assert(lines[0].reversal_entry_no !== null, 'the line names the entry that reversed it');
    });

    await check('rtv_self_approval · the person who raised it cannot approve it', async () => {
      // Raised by a Site Manager, who also holds RTV.APPROVE — so the
      // permission passes and only the self-approval rule refuses. Raised by a
      // Warehouse Lead it would be stopped a step earlier, by the permission,
      // and this rule would never be reached.
      const created = await rtv.createRtv(SMGR, {
        source: 'SHORTFALL', basis: 'CREDIT',
        shortfallId: Number((await shortfalls.listShortfalls(SMGR.principal, { decision: 'AWAIT_BALANCE' }))[0].id),
      });
      shortfallRtvId = Number(created.id);

      await rejects(
        () => rtv.approveRtv(SMGR, shortfallRtvId),
        /raised this return/i,
        'self-approval',
      );
    });

    await check('source · SHORTFALL posts nothing — the goods never arrived', async () => {
      const ledgerBefore = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM stock_ledger WHERE source_type = 'RTV_LINE'`;

      const { rtv: approved, entries } = await rtv.approveRtv(FHEAD, shortfallRtvId);
      assertEqual(entries, [], 'no movements');
      assert(String(approved.prn_no).startsWith('PRN-DHU-'), 'but the PRN is still minted');
      assert(String(approved.gate_pass_no).startsWith('RGP-DHU-'), 'and the gate pass too');

      const ledgerAfter = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM stock_ledger WHERE source_type = 'RTV_LINE'`;
      assertEqual(ledgerAfter[0].n, ledgerBefore[0].n, 'the ledger is untouched');
    });

    await check('source · QC_REJECTION posts nothing either — it never entered stock', async () => {
      const created = await rtv.createRtv(QCI, {
        source: 'QC_REJECTION', basis: 'CREDIT', qcId,
      });
      const qcRtvId = Number(created.id);

      const { lines } = await rtv.getRtv(qcRtvId);
      assertEqual(lines.length, 1, 'the rejected pallets');
      assertEqual(lines[0].qty, '2.000', 'two of them');

      const before = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      const beforeAvailable = Number(before.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0);

      const { entries } = await rtv.approveRtv(SMGR, qcRtvId);
      assertEqual(entries, [], 'no movements');

      const after = await inTransaction(tx => stock.balancesFor(tx, siteA, palletId));
      assertEqual(
        Number(after.find(b => b.bucket === 'AVAILABLE')?.qty ?? 0),
        beforeAvailable,
        'and the balance is exactly as it was',
      );

      const { lines: after2 } = await rtv.getRtv(qcRtvId);
      assertEqual(after2[0].reversal_entry_no, null, 'the line has no reversal to name');
    });

    await check('the same origin cannot be returned twice', async () => {
      await rejects(
        () => rtv.createRtv(QCI, { source: 'QC_REJECTION', basis: 'CREDIT', qcId }),
        /already been returned as RTV-/i,
        'duplicate return',
      );
    });

    await check('damage with no traceable receipt cannot be returned to anybody', async () => {
      const report = await damage.reportDamage(WHL, {
        siteId: siteA, itemId: palletId, qty: '1', cause: 'PEST_CONTAMINATION',
        observedOn: '2026-09-23',
      });
      const id = Number(report.id);

      await rejects(
        () => rtv.createRtv(WHL, { source: 'WAREHOUSE_DAMAGE', basis: 'CREDIT', damageId: id }),
        /no receipt behind it.*repaired or written off/is,
        'untraceable damage',
      );
    });

    await check('the return is dispatched, acknowledged and closed', async () => {
      const dispatched = await rtv.dispatchRtv(RCV, damageRtvId, {
        transporter: 'Sundar Roadways', lrNo: 'LR-55120', ewayBillNo: 'EWB-771920334455',
      });
      assertEqual(dispatched.status, 'RTV_DISPATCHED', 'dispatched');
      assert(dispatched.dispatched_at !== null, 'stamped');

      await rejects(
        () => rtv.acknowledgeRtv(BUY, damageRtvId, '   '),
        /vendor.s reference/i,
        'acknowledgement without a reference',
      );

      const acked = await rtv.acknowledgeRtv(BUY, damageRtvId, 'RMA-2026-0471');
      assertEqual(acked.status, 'RTV_ACKNOWLEDGED', 'acknowledged');
      assertEqual(acked.vendor_rma_no, 'RMA-2026-0471', 'with the vendor reference');

      const closed = await rtv.closeRtv(ACC, damageRtvId, 'Free replacement received');
      assertEqual(closed.status, 'RTV_CLOSED', 'closed');
    });

    await check('cancelling an approved return puts the stock back', async () => {
      // The last available logger, taken through the whole chain again.
      const units = await assets.listAssets(SMGR.principal, { itemId: serialItemId, bucket: 'AVAILABLE' });
      const report = await damage.reportDamage(WHL, {
        siteId: siteA, itemId: serialItemId, qty: '1', cause: 'INTERNAL_TRANSIT',
        observedOn: '2026-09-23', assetUnitId: Number(units[0].id),
      });
      const dmgId = Number(report.id);
      await damage.inspectDamage(SMGR, dmgId, 'Casing cracked in transit between bays');
      await damage.inspectDamage(QCI, dmgId, 'Confirmed; sensor no longer seated');
      await damage.decideDamage(WHL, dmgId, 'WARRANTY_CLAIM');
      await damage.approveDamageDecision(FHEAD, dmgId);

      const created = await rtv.createRtv(WHL, {
        source: 'WAREHOUSE_DAMAGE', basis: 'CREDIT', damageId: dmgId,
      });
      const id = Number(created.id);
      await rtv.approveRtv(SMGR, id);

      const drained = await inTransaction(tx => stock.balancesFor(tx, siteA, serialItemId));
      assertEqual(drained.find(b => b.bucket === 'DAMAGED_HOLD')?.qty, '0.000', 'gone on approval');

      await rtv.cancelRtv(SMGR, id, 'Vendor refused the claim; keeping it here');

      const back = await inTransaction(tx => stock.balancesFor(tx, siteA, serialItemId));
      assertEqual(back.find(b => b.bucket === 'DAMAGED_HOLD')?.qty, '1.000', 'and back on cancellation');
    });


    // =====================================================================
    // Accounts — invoice, three-way match, debit note, credit note, recon
    // =====================================================================
    let invoiceId = 0;

    // Who actually won the award, and what the goods that arrived are worth at
    // order rates. Both are read rather than assumed — the award is decided by
    // the view's rank, so hardcoding a vendor here would be asserting the
    // outcome of a test that already ran.
    const { po: billedPo, lines: billedLines } = await poSvc.getPo(poId);
    const billedVendorId = Number(billedPo.vendor_id);
    const receivedValue = billedLines
      .reduce((sum, l) => sum + Number(l.qty_received ?? 0) * Number(l.rate), 0)
      .toFixed(2);
    const gstHalf = (Number(receivedValue) * 0.09).toFixed(2);
    const invoiceTotal = (Number(receivedValue) + Number(gstHalf) * 2).toFixed(2);

    await check('GST mode · an inter-state tax on an intra-state supply is refused', async () => {
      // Dhulagarh is state 19 and so is Frostline, so this supply never crosses
      // a state line. IGST would misstate the input tax credit.
      await rejects(
        () =>
          invoices.recordInvoice(ACC, {
            poId, invoiceNo: 'FR/2026/0001', invoiceDate: '2026-09-23',
            placeOfSupply: '19', taxableValue: receivedValue, igst: '46692',
          }),
        /intra-state supply.*CGST and SGST, not IGST/is,
        'wrong GST mode',
      );
    });

    await check('GST mode · CGST and SGST must be equal', async () => {
      await rejects(
        () =>
          invoices.recordInvoice(ACC, {
            poId, invoiceNo: 'FR/2026/0001', invoiceDate: '2026-09-23',
            placeOfSupply: '19', taxableValue: receivedValue, cgst: gstHalf, sgst: '20000',
          }),
        /always equal on an intra-state supply/i,
        'unequal halves',
      );
    });

    await check('an invoice is booked, and raises the payable', async () => {
      const invoice = await invoices.recordInvoice(ACC, {
        poId, invoiceNo: 'FR/2026/0001', invoiceDate: '2026-09-23',
        placeOfSupply: '19', taxableValue: receivedValue, cgst: gstHalf, sgst: gstHalf,
      });
      invoiceId = Number(invoice.id);
      assertEqual(invoice.total, invoiceTotal, 'total is generated from its parts');
      assertEqual(invoice.status, 'INV_RECEIVED', 'received');

      const bal = await inTransaction(tx => accountsLedger.balance(tx, billedVendorId, 'PORTAL'));
      assertEqual(bal, invoiceTotal, 'the payable went up by the invoice total');
    });

    await check('vendor_invoices_no_uq · the same invoice cannot be booked twice', async () => {
      await rejects(
        () =>
          invoices.recordInvoice(ACC, {
            poId, invoiceNo: '  fr/2026/0001  ', invoiceDate: '2026-09-23',
            placeOfSupply: '19', taxableValue: '100', cgst: '9', sgst: '9',
          }),
        /already booked/i,
        'duplicate invoice',
      );
    });

    await check('the three-way match compares the order, the receipts and the bill', async () => {
      const match = await invoices.threeWayMatch(invoiceId);
      assertEqual(match.receivedTaxable, receivedValue, 'received at order rates');
      assertEqual(match.invoiceTaxable, receivedValue, 'billed');
      assert(match.matches, 'and they agree');

      // Only APPROVED receipts count: the flagged over-receipt is excluded, so
      // the coil shows the one that was actually received.
      const coil = match.lines.find(l => l.itemCode === 'CC-EVP-220');
      assertEqual(coil?.qtyReceived, '1.000', 'the flagged second coil is not counted');
    });

    await check('an invoice billing more than arrived cannot be matched silently', async () => {
      const over = await invoices.recordInvoice(ACC, {
        poId, invoiceNo: 'FR/2026/0002', invoiceDate: '2026-09-23',
        placeOfSupply: '19',
        taxableValue: (Number(receivedValue) + 100000).toFixed(2),
        cgst: '36000', sgst: '36000',
      });

      await rejects(
        () => invoices.matchInvoice(ACC, Number(over.id)),
        /more than the goods.*debit note.*or dispute/is,
        'over-billed invoice',
      );

      await invoices.disputeInvoice(ACC, Number(over.id), 'Billed for the flagged over-receipt');
    });

    await check('the matched invoice is released and paid, net of anything held', async () => {
      await invoices.matchInvoice(ACC, invoiceId);
      await invoices.holdInvoice(ACC, invoiceId, '5000.00', 'Pending the damaged logger credit');
      await invoices.releaseInvoice(FHEAD, invoiceId, 'Released for payment less the hold');

      const paid = await invoices.payInvoice(ACC, invoiceId, 'NEFT/2026/09/8812');
      assertEqual(paid.status, 'INV_PAID', 'paid');

      const bal = await inTransaction(tx => accountsLedger.balance(tx, billedVendorId, 'PORTAL'));
      // Everything but the withheld amount has been paid away — plus the
      // over-billed invoice above, which is disputed but still booked. A
      // dispute is a flag on an invoice, not an un-booking of it: the vendor
      // has billed, and the payable says so until it is settled or cancelled.
      const [disputed] = await sql<{ total: string }[]>`
        SELECT total::text FROM vendor_invoices WHERE invoice_no = 'FR/2026/0002'`;
      assertEqual(bal, (5000 + Number(disputed.total)).toFixed(2), 'the held amount and the disputed bill');
    });

    // =====================================================================
    // Debit notes
    // =====================================================================
    let dnId = 0;

    await check('dn_one_source · a debit note needs exactly one origin', async () => {
      await rejects(
        () => debitNotes.createDebitNote(ACC, {}),
        /exactly one of them/i,
        'no origin',
      );
      await rejects(
        () => debitNotes.createDebitNote(ACC, { rtvId: damageRtvId, shortfallId: 1 }),
        /exactly one of them/i,
        'two origins',
      );
    });

    await check('a shortfall still awaiting its balance cannot be debited', async () => {
      const open = await shortfalls.listShortfalls(SMGR.principal, { decision: 'AWAIT_BALANCE' });
      await rejects(
        () => debitNotes.createDebitNote(ACC, { shortfallId: Number(open[0].id) }),
        /still awaiting the balance.*owes goods, not money/is,
        'premature debit',
      );
    });

    await check('a debit note mirrors the invoice tax, and reduces the payable when issued', async () => {
      // The shortfall return is against the same order the invoice bills, which
      // is what lets its tax be mirrored. A return against a different order
      // would be a different vendor's problem.
      await rtv.dispatchRtv(RCV, shortfallRtvId, { transporter: 'Sundar Roadways' });

      const dn = await debitNotes.createDebitNote(ACC, {
        rtvId: shortfallRtvId, vendorInvoiceId: invoiceId,
      });
      dnId = Number(dn.id);
      assert(String(dn.dn_no).startsWith('DN-DHU-'), `numbered at the site: ${dn.dn_no}`);

      const taxable = Number(dn.taxable_value);
      assert(taxable > 0, 'valued from the return');
      const expectedCgst = ((taxable / Number(receivedValue)) * Number(gstHalf)).toFixed(2);
      assertEqual(dn.cgst, expectedCgst, 'CGST mirrored in proportion to the invoice');
      assertEqual(dn.igst, '0.00', 'and no IGST, matching the invoice');

      const before = await inTransaction(tx => accountsLedger.balance(tx, billedVendorId, 'PORTAL'));
      await debitNotes.issueDebitNote(ACC, dnId, 'TALLY-DN-0001');
      const after = await inTransaction(tx => accountsLedger.balance(tx, billedVendorId, 'PORTAL'));

      assertEqual(Number(before) - Number(after), Number(dn.total), 'the payable fell by the note');
    });

    await check('the same return cannot be debited twice', async () => {
      await rejects(
        () => debitNotes.createDebitNote(ACC, { rtvId: shortfallRtvId }),
        /already been debited as DN-/i,
        'duplicate debit note',
      );
    });

    // =====================================================================
    // Credit notes and C-14
    // =====================================================================
    let creditNoteId = 0;

    await check('a short credit note is flagged by the trigger, not by us', async () => {
      const { creditNote } = await debitNotes.recordCreditNote(ACC, dnId, {
        cnNo: 'FR-CN-77', cnDate: '2026-09-23', value: '15000',
      });
      creditNoteId = Number(creditNote.id);

      // Well short of what was debited, so the trigger flags it.
      assert(Number(creditNote.variance_pct) > 2, `variance ${creditNote.variance_pct}%`);
      assertEqual(creditNote.variance_flagged, true, 'flagged above the 2% tolerance');
      assertEqual(creditNote.accepted_short_by, null, 'and nobody has accepted it');
    });

    await check('C-14 · a flagged credit note blocks reconciliation', async () => {
      await rejects(
        () => debitNotes.reconcileDebitNote(ACC, dnId, 'TALLY-DN-0001'),
        /short of the.*above the 2% tolerance.*Functional Head/is,
        'reconciling while flagged',
      );
    });

    await check('C-14 · only a Functional Head may accept the shortfall', async () => {
      await rejects(
        () => debitNotes.acceptShortCredit(ACC, creditNoteId, 'Agreed with the vendor on a settlement'),
        /Functional Head/i,
        'accounts accepting short',
      );
    });

    await check('C-14 · the override unblocks it, and is audited as an override', async () => {
      const accepted = await debitNotes.acceptShortCredit(
        FHEAD, creditNoteId,
        'Vendor disputes the handling damage; settled at 15,000 to keep the supply line',
      );
      assert(accepted.accepted_short_by !== null, 'accepted');

      const reconciled = await debitNotes.reconcileDebitNote(ACC, dnId, 'TALLY-DN-0001');
      assertEqual(reconciled.status, 'DN_RECONCILED', 'now it reconciles');

      const overrides = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM audit_log
         WHERE entity_type = 'CREDIT_NOTE' AND action = 'OVERRIDE'`;
      assertEqual(overrides[0].n, '1', 'recorded as an override, not an ordinary update');
    });

    await check('dn_reconciled_needs_tally · reconciling needs the voucher reference', async () => {
      // The logger return, which is closed and so has certainly left.
      const dn2 = await debitNotes.createDebitNote(ACC, { rtvId: damageRtvId });
      await debitNotes.issueDebitNote(ACC, Number(dn2.id), 'TALLY-DN-0002');
      await debitNotes.recordCreditNote(ACC, Number(dn2.id), {
        cnNo: 'FR-CN-78', cnDate: '2026-09-23', value: String(dn2.total),
      });

      await rejects(
        () => debitNotes.reconcileDebitNote(ACC, Number(dn2.id), '   '),
        /needs the Tally voucher reference/i,
        'no voucher',
      );
    });

    // =====================================================================
    // Reconciliation
    // =====================================================================
    let runId = 0;

    await check('a reconciliation with no Tally side is all one-sided', async () => {
      const { run, items } = await recon.runReconciliation(ACC, {
        vendorId: billedVendorId, periodStart: '2026-09-01', periodEnd: '2026-09-30',
      });
      runId = Number(run.id);

      assertEqual(run.tally_balance, '0.00', 'nothing imported yet');
      assert(Number(run.difference) !== 0, 'so the two sides differ');
      assertEqual(run.status, 'RECON_DIFFERENCE', 'and it says so');
      assert(items.every(i => i.match_status === 'ONLY_IN_PORTAL'), 'every row sits on one side');
    });

    await check('recon_zero_to_close · a run with a difference cannot be closed', async () => {
      await rejects(
        () => recon.closeReconciliation(ACC, runId),
        /out by .*cannot be closed away/is,
        'closing a difference',
      );
    });

    await check('the Tally side is imported exactly as supplied', async () => {
      const portal = await inTransaction(tx => accountsLedger.entries(billedVendorId, 'PORTAL'));

      const { imported } = await recon.importTally(
        ACC,
        billedVendorId,
        portal.map(e => ({
          entryDate: new Date(e.entry_date as string).toISOString().slice(0, 10),
          docType: String(e.doc_type) as 'INVOICE',
          docRef: String(e.doc_ref),
          amount: String(e.amount),
        })),
      );
      assertEqual(imported, portal.length, 'every row landed');

      // Re-importing the same file adds nothing.
      const again = await recon.importTally(ACC, billedVendorId, [
        {
          entryDate: new Date(portal[0].entry_date as string).toISOString().slice(0, 10),
          docType: String(portal[0].doc_type) as 'INVOICE',
          docRef: String(portal[0].doc_ref),
          amount: String(portal[0].amount),
        },
      ]);
      assertEqual(again.imported, 0, 'nothing duplicated');
      assertEqual(again.skipped, 1, 'it was recognised as already present');
    });

    await check('a balanced run matches both sides and closes', async () => {
      const { run, items } = await recon.runReconciliation(ACC, {
        vendorId: billedVendorId, periodStart: '2026-09-01', periodEnd: '2026-09-30',
      });
      assertEqual(run.difference, '0.00', 'the two sides agree');

      const unpaired = items.filter(i => i.match_status !== 'MATCHED');
      assertEqual(
        unpaired.map(i => `${i.match_status}:${i.portal_ref ?? i.tally_ref}`),
        [],
        'every row paired up',
      );

      const closed = await recon.closeReconciliation(ACC, Number(run.id), 'September settled');
      assertEqual(closed.status, 'RECON_RECONCILED', 'closed');
    });

    await check('a vendor confirmation that disagrees is a new difference, not agreement', async () => {
      const runs = await recon.listRuns(ACC.principal, { vendorId: billedVendorId });
      const closed = runs.find(r => r.status === 'RECON_RECONCILED')!;

      await rejects(
        () => recon.confirmReconciliation(ACC, Number(closed.id), '99999'),
        /fresh difference.*reopen the run/is,
        'disagreeing confirmation',
      );

      const confirmed = await recon.confirmReconciliation(
        ACC, Number(closed.id), String(closed.portal_balance),
      );
      assertEqual(confirmed.status, 'RECON_CONFIRMED_BY_VENDOR', 'confirmed');
    });


    // =====================================================================
    // Dashboard and audit trail
    // =====================================================================
    const tile = (groups: { key: string; metrics: { key: string; value: string }[] }[], g: string, k: string) =>
      groups.find(x => x.key === g)?.metrics.find(m => m.key === k)?.value;

    await check('every dashboard tile names the query that produced it', async () => {
      const groups = await dash.dashboard(ADMIN.principal);
      assertEqual(groups.length, 6, 'six groups');

      const metrics = groups.flatMap(g => g.metrics);
      assert(metrics.length >= 24, `${metrics.length} metrics`);

      const untraceable = metrics.filter(m => !m.query).map(m => m.key);
      assertEqual(untraceable, [], 'every metric carries its query');

      // The query name has to be a real exported function, not a label.
      const names = [...new Set(metrics.map(m => m.query))];
      const missing = names.filter(n => typeof (dash as Record<string, unknown>)[n] !== 'function');
      assertEqual(missing, [], 'every named query exists');
    });

    await check('the tiles agree with the records behind them', async () => {
      const groups = await dash.dashboard(ADMIN.principal);

      // Counted independently, so a tile that drifted from the data would show.
      const [counts] = await sql<Record<string, string>[]>`
        SELECT
          (SELECT count(*) FROM purchase_orders WHERE status = 'PO_DRAFT')            AS po_draft,
          (SELECT count(*) FROM shortfall_cases WHERE decision = 'PENDING')           AS shortfalls,
          (SELECT count(*) FROM asset_units WHERE bucket <> 'WRITTEN_OFF')            AS assets,
          (SELECT count(*) FROM vendors WHERE status = 'VENDOR_APPROVED')             AS approved,
          (SELECT count(*) FROM vendors WHERE status = 'VENDOR_BLOCKED')              AS blocked`;

      assertEqual(tile(groups, 'procurement', 'po_unissued'), String(counts.po_draft), 'orders not issued');
      assertEqual(tile(groups, 'receiving', 'shortfalls'), String(counts.shortfalls), 'shortfalls undecided');
      assertEqual(tile(groups, 'inventory', 'assets'), String(counts.assets), 'serialised units');
      assertEqual(tile(groups, 'quality', 'approved'), String(counts.approved), 'approved vendors');
      assertEqual(tile(groups, 'quality', 'blocked'), String(counts.blocked), 'blocked vendors');
    });

    await check('a tile moves when the thing behind it moves', async () => {
      const before = await dash.dashboard(ADMIN.principal);
      const wasBlocked = Number(tile(before, 'quality', 'blocked'));

      await vendors.blockVendor(FHEAD, polar, 'Repeated late delivery on the September orders');

      const after = await dash.dashboard(ADMIN.principal);
      assertEqual(Number(tile(after, 'quality', 'blocked')), wasBlocked + 1, 'blocked count followed');

      await vendors.unblockVendor(FHEAD, polar);
    });

    await check('the dashboard shows a site manager only their own sites', async () => {
      // Rina holds both sites; a manager at Pune alone should see less.
      const pune = { principal: principal(managerId, ['CG_SMGR'], [bothSites[1]]), ip: null };

      const wide = await dash.dashboard(ADMIN.principal);
      const narrow = await dash.dashboard(pune.principal);

      const wideAssets = Number(tile(wide, 'inventory', 'assets'));
      const narrowAssets = Number(tile(narrow, 'inventory', 'assets'));

      assert(wideAssets > 0, 'the group holds serialised units');
      assertEqual(narrowAssets, 0, 'and none of them are at Pune');
    });

    await check('the audit trail reads, and overrides are findable', async () => {
      const all = await auditView.auditTrail(ADMIN.principal, { limit: 500 });
      assert(all.length > 50, `${all.length} entries recorded across the chain`);

      const overrides = await auditView.auditTrail(ADMIN.principal, { action: 'OVERRIDE' });
      assert(overrides.length > 0, 'the chain produced overrides');
      assert(
        overrides.every(e => e.action === 'OVERRIDE'),
        'and the filter returns only those',
      );

      // Every override should say why. That is the whole reason it is one.
      const silent = overrides.filter(e => !e.remarks).map(e => e.entity_type);
      assertEqual(silent, [], 'every override carries a reason');
    });

    await check('one record’s whole history reads in order', async () => {
      const history = await auditView.historyOf(ADMIN.principal, 'PR', prId);
      assert(history.length >= 3, `${history.length} entries on the purchase request`);

      const ids = history.map(h => Number(h.id));
      assertEqual(ids, [...ids].sort((a, b) => a - b), 'oldest first');

      const statuses = history.filter(h => h.to_status).map(h => String(h.to_status));
      assert(statuses.includes('PR_APPROVED'), 'the approval is in it');
      assert(statuses.includes('PO_POSTED'), 'and so is the order that followed');
    });

    await check('the audit summary counts what the trail actually holds', async () => {
      const summary = await auditView.auditSummary(ADMIN.principal);

      const [actual] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log`;
      assertEqual(summary.total, Number(actual.n), 'total');

      const summed = summary.actions.reduce((s, a) => s + a.n, 0);
      assertEqual(summed, summary.total, 'the action breakdown adds up to the total');

      const byEntity = summary.entityTypes.reduce((s, e) => s + e.n, 0);
      assertEqual(byEntity, summary.total, 'and so does the entity breakdown');
    });

    await check('reading the audit trail needs permission', async () => {
      await rejects(
        () => auditView.auditTrail(REQ.principal, {}),
        /do not have permission to read the audit trail/i,
        'audit permission',
      );
    });


    // =====================================================================
    // Hardening — rollback, constraints, performance
    // =====================================================================
    await check('§28 · a failure part way through leaves nothing behind', async () => {
      // An issue whose second line cannot be met. The first line must not post,
      // and the issue header must not exist — the document number counter
      // included, since it increments inside the same transaction.
      const before = await sql<{ n: string; serial: string }[]>`
        SELECT (SELECT count(*)::text FROM stock_issues)                          AS n,
               (SELECT coalesce(max(last_serial), 0)::text FROM id_counters
                 WHERE entity = 'ISS')                                            AS serial`;

      await rejects(
        () =>
          issues.createIssue(WHL, {
            siteId: siteA, issuedTo: 'Rollback probe',
            lines: [
              { itemId: palletId, qty: '1' },
              { itemId: coilId, qty: '999999' },
            ],
          }),
        /not enough to issue/i,
        'partial issue',
      );

      const after = await sql<{ n: string; serial: string }[]>`
        SELECT (SELECT count(*)::text FROM stock_issues)                          AS n,
               (SELECT coalesce(max(last_serial), 0)::text FROM id_counters
                 WHERE entity = 'ISS')                                            AS serial`;

      assertEqual(after[0].n, before[0].n, 'no issue header survived');
      assertEqual(after[0].serial, before[0].serial, 'and the number counter rolled back with it');
    });

    await check('§28 · a rolled-back transaction leaves no ledger entry', async () => {
      const before = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM stock_ledger`;

      await rejects(
        () =>
          issues.createIssue(WHL, {
            siteId: siteA, issuedTo: 'Ledger rollback probe',
            lines: [
              { itemId: palletId, qty: '1' },
              { itemId: serialItemId, qty: '999999' },
            ],
          }),
        /not enough to issue/i,
        'partial ledger write',
      );

      const after = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM stock_ledger`;
      assertEqual(after[0].n, before[0].n, 'the ledger is untouched');
    });

    await check('§28 · a rolled-back transaction leaves no audit row', async () => {
      const before = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log`;

      await rejects(
        () =>
          damage.reportDamage(WHL, {
            siteId: siteA, itemId: palletId, qty: '999999', cause: 'HANDLING',
            observedOn: '2026-09-24',
          }),
        /cannot be quarantined/i,
        'audit rollback',
      );

      const after = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log`;
      assertEqual(after[0].n, before[0].n, 'nothing was written');
    });

    await check('the ledger and the balances cannot be edited directly', async () => {
      // forbid_mutation() sits on both. If either ever came off, every figure
      // in the system would become an opinion.
      await rejects(
        () => sql`UPDATE stock_ledger SET qty = qty + 1 WHERE id = (SELECT min(id) FROM stock_ledger)`,
        /append-only|cannot be (modified|changed|updated)|immutable|forbid/i,
        'editing the ledger',
      );

      await rejects(
        () => sql`DELETE FROM audit_log WHERE id = (SELECT min(id) FROM audit_log)`,
        /append-only|cannot be (modified|changed|deleted)|immutable|forbid/i,
        'deleting an audit row',
      );
    });

    await check('stock cannot be driven negative, whatever the route', async () => {
      // The service checks under a lock; the CHECK constraint is the backstop.
      // This goes at the constraint directly, past every service.
      await rejects(
        () => sql`
          UPDATE stock_balances SET qty = -1
           WHERE site_id = ${siteA} AND item_id = ${palletId} AND bucket = 'AVAILABLE'`,
        /negative|check constraint|qty/i,
        'negative balance',
      );
    });

    await check('performance · the dashboard answers quickly', async () => {
      // Six queries in parallel. The number here is generous on purpose: this
      // is a smoke test against an accidental cross join, not a benchmark.
      const started = Date.now();
      await dash.dashboard(ADMIN.principal);
      const elapsed = Date.now() - started;

      assert(elapsed < 3000, `the dashboard took ${elapsed}ms`);
    });

    await check('performance · the ledger reads quickly under its index', async () => {
      const started = Date.now();
      const rows = await inventory.ledger(ADMIN.principal, { siteId: siteA, limit: 200 });
      const elapsed = Date.now() - started;

      assert(rows.length > 0, 'the ledger has entries to read');
      assert(elapsed < 2000, `the ledger took ${elapsed}ms`);
    });

    await check('performance · the stock position uses its site predicate', async () => {
      // v_stock_position cross-joins sites to items (conflict C-21), so this is
      // the query most likely to degrade if the predicate is ever dropped.
      const plan = await sql<{ line: string }[]>`
        EXPLAIN SELECT * FROM v_stock_position WHERE site_id = ${siteA}`;

      const text = plan.map(r => Object.values(r)[0]).join('\n');
      assert(
        /Index|Filter|Seq Scan on sites/i.test(text),
        'the plan narrows by site rather than materialising every pair',
      );
    });

    await check('the whole chain is in the audit trail', async () => {
      const rows = await sql<{ entity_type: string; action: string }[]>`
        SELECT entity_type, action FROM audit_log ORDER BY id`;

      for (const entity of [
        'MR', 'TRANSFER', 'PR', 'QUOTATION', 'QUOTE_AWARD', 'PO', 'VENDOR',
        'GATE_INWARD', 'QC_LINE', 'GRN', 'SHORTFALL',
        'STOCK', 'STOCK_ISSUE', 'ASSET_UNIT', 'DAMAGE', 'RTV',
        'INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'RECON',
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
