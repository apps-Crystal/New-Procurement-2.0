/**
 * The permission matrix, proven against the services (brief §26, §33).
 *
 *   npm run verify:permissions
 *
 * `PERMISSION_MATRIX` says which roles may do what. This checks that the
 * SERVICES agree — that a role the matrix denies is actually refused when it
 * tries, rather than merely hidden from in the navigation.
 *
 * The test is deliberately not "call can() and compare to the matrix", which
 * would only prove the matrix equals itself. Every probe calls the real service
 * with a principal holding exactly one role, and asserts:
 *
 *   matrix says no  →  the call fails with FORBIDDEN
 *   matrix says yes →  the call fails with anything BUT forbidden, or succeeds
 *
 * That second half matters as much as the first. A permitted role may still be
 * refused on state — wrong status, missing quotation, nothing to approve — and
 * that is correct. What it must never hit is the authorisation wall.
 *
 * Records are seeded first, because a service that loads its record before
 * checking the permission would otherwise answer NOT_FOUND to everyone and the
 * probe would prove nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import type { Principal, RoleCode, PermissionKey } from '../lib/auth/permissions';

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'crystal_procurement_verify_perms';

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

const ALL_ROLES: RoleCode[] = [
  'CG_REQ', 'CG_SMGR', 'CG_BUY', 'CG_RCV', 'CG_QC',
  'CG_WHL', 'CG_ACC', 'CG_ADM', 'CG_FHEAD', 'CG_DIR',
];

interface Failure {
  probe: string;
  role: RoleCode;
  expected: string;
  got: string;
}

const failures: Failure[] = [];
let checks = 0;

function errorKind(e: unknown): string {
  if (e && typeof e === 'object' && 'kind' in e) return String((e as { kind: unknown }).kind);
  return 'UNKNOWN';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function main() {
  console.log('\nCrystal Procurement 2.0 — permission matrix verification\n');

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
    console.log('ok');
  } finally {
    await migrator.end({ timeout: 5 });
  }

  const { sql, inTransaction } = await import('../lib/db');
  const { can } = await import('../lib/auth/permissions');
  const masters = await import('../lib/services/masters');
  const vendors = await import('../lib/services/vendors');
  const mrSvc = await import('../lib/services/mr');
  const transfers = await import('../lib/services/transfers');
  const prSvc = await import('../lib/services/pr');
  const quotes = await import('../lib/services/quotations');
  const poSvc = await import('../lib/services/po');
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
  const auditView = await import('../lib/services/audit-trail');

  try {
    // =====================================================================
    // Seed: one of everything, so a probe reaches its permission check
    // rather than tripping over a missing record.
    // =====================================================================
    process.stdout.write('  seeding … ');

    const mkUser = async (key: string) => {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO app_users (core_user_id, email, full_name)
        VALUES (${`perm-${key}`}, ${`${key}@crystalgroup.in`}, ${key}) RETURNING id`;
      return Number(u.id);
    };

    const principal = (id: number, roles: RoleCode[], sites: { id: number; code: string; name: string }[]): Principal => ({
      userId: id,
      coreUserId: `perm-${id}`,
      email: `u${id}@crystalgroup.in`,
      fullName: `User ${id}`,
      sites: sites.map(s => ({ siteId: s.id, siteCode: s.code, siteName: s.name, roles })),
      roles,
      groupWide: roles.some(r => r === 'CG_ADM' || r === 'CG_DIR'),
    });

    // The seeder holds every role. It is a fixture, not a person — no real
    // account is ever granted the whole matrix.
    const seedId = await mkUser('seed');
    // A second fixture, because the maker-checker rules are real: the person
    // who creates a vendor cannot approve it, and the seeder is not exempt.
    const seed2Id = await mkUser('seed2');
    // And a third, because a goods receipt needs three different people:
    // grns_segregation requires the approver to be neither the receiver nor
    // the inspector. The seeder is not exempt from that either.
    const seed3Id = await mkUser('seed3');
    const otherId = await mkUser('other');

    const bootstrap = { principal: principal(seedId, ALL_ROLES, []), ip: null };

    const siteA = Number((await masters.createSite(bootstrap, {
      code: 'DHU', name: 'Dhulagarh', siteType: 'WAREHOUSE', address: 'Dhulagarh, WB',
      stateCode: '19', gstin: '19AABCU9603R1ZX', tallyCostCentre: 'CC-DHU', status: 'ACTIVE',
    })).id);
    const siteB = Number((await masters.createSite(bootstrap, {
      code: 'PUN', name: 'Pune', siteType: 'WAREHOUSE', address: 'Pune, MH',
      stateCode: '27', gstin: '27AABCU9603R1Z0', tallyCostCentre: 'CC-PUN', status: 'ACTIVE',
    })).id);

    const sites = [
      { id: siteA, code: 'DHU', name: 'Dhulagarh' },
      { id: siteB, code: 'PUN', name: 'Pune' },
    ];

    const SEED = { principal: principal(seedId, ALL_ROLES, sites), ip: null };
    const SEED2 = { principal: principal(seed2Id, ALL_ROLES, sites), ip: null };
    const SEED3 = { principal: principal(seed3Id, ALL_ROLES, sites), ip: null };

    const classId = Number((await masters.createItemClass(SEED, { code: 'AMB', name: 'Ambient' })).id);
    const itemId = Number((await masters.createItem(SEED, {
      code: 'PL-HDPE-12', name: 'HDPE pallet', itemClassId: classId, uom: 'Nos',
    })).id);
    const budgetId = Number((await masters.createBudgetCode(SEED, {
      code: 'MAINT', financialYear: 'FY26-27', category: 'MAINTENANCE_CAPEX',
    })).id);
    await masters.publishChecklist(SEED, {
      itemClassId: classId, version: 'AMB-v1', points: ['Packaging intact'],
    });

    // Three vendors, so a comparison needs no waiver — the waiver path has its
    // own approval chain and would block the seed before the probes ran.
    const mkVendor = async (code: string, name: string, pan: string, gstin: string) => {
      const v = await vendors.createVendor(SEED, {
        legalName: name, pan, gstin, stateCode: '19', address: 'Howrah, WB',
      });
      await vendors.submitVendor(SEED, Number(v.id));
      await vendors.approveVendor(SEED2, Number(v.id), `TALLY-${code}`);
      return Number(v.id);
    };

    const vendorId = await mkVendor('NP', 'Northern Polymers', 'AABCN1234R', '19AABCN1234R1ZP');
    const vendorB = await mkVendor('AC', 'Arctic Cool', 'AABCA1234R', '19AABCA1234R1ZQ');
    const vendorC = await mkVendor('PT', 'Polar Tech', 'AABCP1234R', '19AABCP1234R1ZM');

    // The whole chain, once. Every probe needs a real record to act on — a
    // service that loads before it authorises would otherwise answer NOT_FOUND
    // to everyone, and the probe would prove nothing either way.
    const mrId = Number((await mrSvc.createMr(SEED, {
      siteId: siteA, category: 'CONSUMABLES', requiredBy: '2026-12-31', urgency: 'ROUTINE',
      lines: [{ itemId, qtyRequested: '10' }],
    })).id);

    await mrSvc.runStockCheck(SEED, mrId);
    await mrSvc.declare(SEED, mrId, {
      businessImpact: 'Seeded so every probe below has something real to be refused on.',
      budgetCodeId: budgetId, estimatedValue: '1000',
      allocations: [{ siteId: siteA, costHead: 'Seed', pct: '100' }],
    });
    await mrSvc.decideMr(SEED2, mrId, true);

    const { lines: seedMrLines } = await mrSvc.getMr(mrId);
    const mrLineId = Number(seedMrLines[0].id);

    const prId = Number((await prSvc.createPr(SEED, {
      mrId, procurementType: 'MATERIAL', purpose: 'Seeded purchase request for the probes',
      expectedDelivery: '2026-12-31',
      paymentTerms: {
        pay_advance_pct: '0', pay_before_delivery_pct: '0', pay_running_pct: '0',
        pay_post_delivery_pct: '100', pay_post_completion_pct: '0', pay_retention_pct: '0',
      },
      lines: [{ mrLineId, estRate: '100', gstRate: '18' }],
    })).id);

    await prSvc.submitPr(SEED, prId);
    const seedState = await prSvc.prApprovalState(prId);
    for (const _ of seedState.levels) await prSvc.decidePr(SEED2, prId, true);

    const { lines: seedPrLines } = await prSvc.getPr(prId);
    const seedPrLineId = Number(seedPrLines[0].id);

    const quoted: number[] = [];
    for (const [v, rate, ref] of [
      [vendorId, '100', 'A'], [vendorB, '110', 'B'], [vendorC, '120', 'C'],
    ] as [number, string, string][]) {
      const q = await quotes.recordQuotation(SEED, {
        prId, vendorId: v, vendorQuoteRef: `SEED-Q-${ref}`,
        quoteDate: '2026-09-24', validUntil: '2026-12-31',
        lines: [{ prLineId: seedPrLineId, unitRate: rate, gstRate: '18' }],
      });
      quoted.push(Number(q.id));
    }

    const quoteId = quoted[0];
    await quotes.award(SEED, { prId, quotationId: quoteId });

    const poId = Number((await poSvc.createPo(SEED, { prId, expectedDelivery: '2026-12-31' })).id);
    await poSvc.issuePo(SEED, poId, 'TALLY-SEED');

    const { lines: seedPoLines } = await poSvc.getPo(poId);
    const poLineId = Number(seedPoLines[0].id);

    // Short by one, so a shortfall case exists to be decided.
    const giId = Number((await gate.createGateInward(SEED, {
      poId, vehicleNo: 'WB23AB4567', challanNo: 'CH-SEED', challanDate: '2026-09-24',
      lines: [{ poLineId, qtyPerChallan: '10', qtyCounted: '9' }],
    })).id);
    await gate.sendToQc(SEED, giId);

    const { qc: seedQc, lines: seedQcLines } = await qcSvc.startInspection(SEED2, giId);
    const qcId = Number(seedQc.id);

    // A three-way split, so a hold exists and a rejection exists.
    await qcSvc.recordVerdict(SEED2, qcId, {
      qcLineId: Number(seedQcLines[0].id),
      qtyAccepted: '6', qtyHold: '2', qtyRejected: '1',
      reasonCode: 'SURFACE_DAMAGE',
    });
    const qcLineId = Number(seedQcLines[0].id);
    await qcSvc.completeInspection(SEED2, qcId);
    await qcSvc.decideHold(SEED, qcLineId, 'CONCESSION', '2', 'Seeded concession');

    const grnId = Number((await grnSvc.createGrn(SEED, { qcId })).id);
    await grnSvc.approveGrn(SEED3, grnId);

    // A damage report, inspected by two different people so it can be decided.
    const damageId = Number((await damage.reportDamage(SEED, {
      siteId: siteA, itemId, qty: '1', cause: 'HANDLING', observedOn: '2026-09-24',
    })).id);
    await damage.inspectDamage(SEED2, damageId, 'Seeded inspection note, long enough to pass');

    // A return, from the QC rejection, taken through to dispatched so a debit
    // note can follow it.
    const rtvId = Number((await rtv.createRtv(SEED, {
      source: 'QC_REJECTION', basis: 'CREDIT', qcId,
    })).id);
    await rtv.approveRtv(SEED2, rtvId);
    await rtv.dispatchRtv(SEED, rtvId, { transporter: 'Seed Roadways' });

    const invoiceId = Number((await invoices.recordInvoice(SEED, {
      poId, invoiceNo: 'INV-SEED', invoiceDate: '2026-09-24',
      placeOfSupply: '19', taxableValue: '800', cgst: '72', sgst: '72',
    })).id);

    const dnId = Number((await debitNotes.createDebitNote(SEED, { rtvId })).id);
    await debitNotes.issueDebitNote(SEED, dnId, 'TALLY-DN-SEED');

    const shortfallId = Number(
      (await shortfalls.listShortfalls(SEED.principal, { decision: 'PENDING' }))[0].id,
    );

    // A serialised unit, so ASSET.EDIT has something real to be refused on.
    // Minted straight onto the receipt line rather than through a second
    // chain — what is under test is the permission, not the minting.
    const serialItemId = Number((await masters.createItem(SEED, {
      code: 'DL-TEMP-01', name: 'Data logger', itemClassId: classId,
      uom: 'Nos', isSerialised: true, warrantyMonths: 24,
    })).id);

    const [seedGrnLine] = await sql<{ id: string }[]>`
      SELECT id FROM grn_lines WHERE grn_id = ${grnId} LIMIT 1`;

    const assetId = Number(
      (await inTransaction(tx =>
        assets.mintUnits(
          tx,
          { grnLineId: Number(seedGrnLine.id), itemId: serialItemId, siteId: siteA, qty: 1 },
          seedId,
        ),
      ))[0].id,
    );

    console.log('ok\n');

    // =====================================================================
    // Probes: one per permission worth proving, across every module.
    // =====================================================================
    type Probe = { key: PermissionKey; label: string; siteId: number | null; run: (actor: { principal: Principal; ip: null }) => Promise<unknown> };

    const probes: Probe[] = [
      {
        key: 'MASTER.ITEM_MANAGE', label: 'create an item class', siteId: null,
        run: a => masters.createItemClass(a, { code: `X${Date.now() % 100000}`, name: 'Probe' }),
      },
      {
        key: 'VENDOR.CREATE', label: 'create a vendor', siteId: null,
        run: a => vendors.createVendor(a, {
          legalName: 'Probe Supplies', pan: 'AABCP9999R', stateCode: '19', address: 'Probe',
        }),
      },
      {
        key: 'VENDOR.APPROVE', label: 'approve a vendor', siteId: null,
        run: a => vendors.approveVendor(a, vendorId, 'TALLY-PROBE'),
      },
      {
        key: 'MR.CREATE', label: 'raise a material request', siteId: siteA,
        run: a => mrSvc.createMr(a, {
          siteId: siteA, category: 'CONSUMABLES', requiredBy: '2026-12-31', urgency: 'ROUTINE',
          lines: [{ itemId, qtyRequested: '1' }],
        }),
      },
      {
        key: 'MR.STOCK_CHECK', label: 'run a stock check', siteId: siteA,
        run: a => mrSvc.runStockCheck(a, mrId),
      },
      {
        key: 'MR.DECLARE', label: 'declare business impact', siteId: siteA,
        run: a => mrSvc.declare(a, mrId, {
          businessImpact: 'A probe declaration long enough to satisfy the forty character minimum rule.',
          budgetCodeId: budgetId, estimatedValue: '1000',
          allocations: [{ siteId: siteA, costHead: 'Probe', pct: '100' }],
        }),
      },
      {
        key: 'MR.APPROVE', label: 'approve a material request', siteId: siteA,
        run: a => mrSvc.decideMr(a, mrId, true),
      },
      {
        key: 'MR.REQUEST_TRANSFER', label: 'request a transfer', siteId: siteA,
        run: a => transfers.requestTransfer(a, {
          mrId, fromSiteId: siteB, toSiteId: siteA,
          lines: [{ itemId, qty: '1' }],
        }),
      },
      {
        key: 'PR.CREATE', label: 'raise a purchase request', siteId: siteA,
        run: a => prSvc.createPr(a, {
          mrId, procurementType: 'MATERIAL', purpose: 'Probe purpose text',
          expectedDelivery: '2026-12-31',
          paymentTerms: {
            pay_advance_pct: '0', pay_before_delivery_pct: '0', pay_running_pct: '0',
            pay_post_delivery_pct: '100', pay_post_completion_pct: '0', pay_retention_pct: '0',
          },
          lines: [{ mrLineId: 1, estRate: '100', gstRate: '18' }],
        }),
      },
      {
        key: 'PR.SUBMIT', label: 'submit a purchase request', siteId: siteA,
        run: a => prSvc.submitPr(a, prId),
      },
      {
        key: 'PR.APPROVE', label: 'approve a purchase request', siteId: siteA,
        run: a => prSvc.decidePr(a, prId, true),
      },
      {
        key: 'QUOTATION.MANAGE', label: 'record a quotation', siteId: siteA,
        run: a => quotes.recordQuotation(a, {
          prId, vendorId, vendorQuoteRef: 'Q-PROBE',
          quoteDate: '2026-09-24', validUntil: '2026-12-31',
          lines: [{ prLineId: seedPrLineId, unitRate: '100', gstRate: '18' }],
        }),
      },
      {
        key: 'AWARD.CREATE', label: 'award a quotation', siteId: siteA,
        run: a => quotes.award(a, { prId, quotationId: quoteId }),
      },
      {
        key: 'PO.CREATE', label: 'draft a purchase order', siteId: siteA,
        run: a => poSvc.createPo(a, { prId, expectedDelivery: '2026-12-31' }),
      },
      {
        key: 'PO.ISSUE', label: 'issue a purchase order', siteId: siteA,
        run: a => poSvc.issuePo(a, poId, 'TALLY-PROBE'),
      },
      {
        key: 'GATE_INWARD.CREATE', label: 'log a delivery', siteId: siteA,
        run: a => gate.createGateInward(a, {
          poId, vehicleNo: 'WB23AB4567', challanNo: `CH-${Date.now() % 100000}`,
          challanDate: '2026-09-24',
          lines: [{ poLineId, qtyPerChallan: '1', qtyCounted: '1' }],
        }),
      },
      {
        key: 'QC.START', label: 'start an inspection', siteId: siteA,
        run: a => qcSvc.startInspection(a, giId),
      },
      {
        key: 'QC.HOLD_DECIDE', label: 'decide a conditional hold', siteId: siteA,
        run: a => qcSvc.decideHold(a, qcLineId, 'CONCESSION', '1', 'Probe reason'),
      },
      {
        key: 'SHORTFALL.DECIDE', label: 'decide a shortfall', siteId: siteA,
        run: a => shortfalls.decideShortfall(a, shortfallId, 'AWAIT_BALANCE'),
      },
      {
        key: 'GRN.CREATE', label: 'draft a goods receipt', siteId: siteA,
        run: a => grnSvc.createGrn(a, { qcId }),
      },
      {
        key: 'GRN.APPROVE', label: 'approve a goods receipt', siteId: siteA,
        run: a => grnSvc.approveGrn(a, grnId),
      },
      {
        key: 'INVENTORY.ISSUE', label: 'issue stock', siteId: siteA,
        run: a => issues.createIssue(a, {
          siteId: siteA, issuedTo: 'Probe', lines: [{ itemId, qty: '1' }],
        }),
      },
      {
        key: 'INVENTORY.ADJUST', label: 'adjust stock to a count', siteId: siteA,
        run: a => inventory.adjustToCount(a, {
          siteId: siteA, itemId, countedQty: '5', reason: 'Probe stock take',
        }),
      },
      {
        key: 'INVENTORY.REVERSE', label: 'reverse a movement', siteId: siteA,
        run: a => inventory.reverseMovement(a, 1, 'Probe reversal'),
      },
      {
        key: 'ASSET.EDIT', label: 'edit an asset unit', siteId: siteA,
        run: a => assets.updateAsset(a, assetId, { serialNo: 'PROBE' }),
      },
      {
        key: 'DAMAGE.CREATE', label: 'report damage', siteId: siteA,
        run: a => damage.reportDamage(a, {
          siteId: siteA, itemId, qty: '1', cause: 'HANDLING',
          observedOn: '2026-09-24', estimatedValue: '100',
        }),
      },
      {
        key: 'DAMAGE.INSPECT', label: 'sign a damage inspection', siteId: siteA,
        run: a => damage.inspectDamage(a, damageId, 'A probe inspection note long enough to pass'),
      },
      {
        key: 'DAMAGE.DECIDE', label: 'decide on damage', siteId: siteA,
        run: a => damage.decideDamage(a, damageId, 'INTERNAL_REPAIR'),
      },
      {
        key: 'RTV.CREATE', label: 'raise a purchase return', siteId: siteA,
        run: a => rtv.createRtv(a, { source: 'QC_REJECTION', basis: 'CREDIT', qcId }),
      },
      {
        key: 'RTV.APPROVE', label: 'approve a purchase return', siteId: siteA,
        run: a => rtv.approveRtv(a, rtvId),
      },
      {
        key: 'RTV.DISPATCH', label: 'dispatch a return', siteId: siteA,
        run: a => rtv.dispatchRtv(a, rtvId, {}),
      },
      {
        key: 'RTV.ACKNOWLEDGE', label: 'acknowledge a return', siteId: siteA,
        run: a => rtv.acknowledgeRtv(a, rtvId, 'RMA-PROBE'),
      },
      {
        key: 'INVOICE.CREATE', label: 'book an invoice', siteId: siteA,
        run: a => invoices.recordInvoice(a, {
          poId, invoiceNo: `INV-${Date.now() % 100000}`, invoiceDate: '2026-09-24',
          placeOfSupply: '19', taxableValue: '100', cgst: '9', sgst: '9',
        }),
      },
      {
        key: 'INVOICE.MATCH', label: 'match an invoice', siteId: siteA,
        run: a => invoices.matchInvoice(a, invoiceId),
      },
      {
        key: 'INVOICE.PAY', label: 'record a payment', siteId: siteA,
        run: a => invoices.payInvoice(a, invoiceId, 'NEFT-PROBE'),
      },
      {
        key: 'DEBIT_NOTE.ISSUE', label: 'raise a debit note', siteId: siteA,
        run: a => debitNotes.createDebitNote(a, { rtvId }),
      },
      {
        key: 'DEBIT_NOTE.RECONCILE', label: 'reconcile a debit note', siteId: siteA,
        run: a => debitNotes.reconcileDebitNote(a, dnId, 'TALLY-PROBE'),
      },
      {
        key: 'RECON.RUN', label: 'take a reconciliation', siteId: null,
        run: a => recon.runReconciliation(a, {
          vendorId, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        }),
      },
      {
        key: 'RECON.IMPORT_TALLY', label: 'import the Tally ledger', siteId: null,
        run: a => recon.importTally(a, vendorId, [
          { entryDate: '2026-09-24', docType: 'INVOICE', docRef: 'PROBE', amount: '1' },
        ]),
      },
      {
        key: 'AUDIT.VIEW', label: 'read the audit trail', siteId: null,
        run: a => auditView.auditTrail(a.principal, {}),
      },
    ];

    // A probe naming a key the matrix does not hold would be silently denied
    // to everyone by can()'s fail-closed rule, and would then prove nothing.
    const { PERMISSION_MATRIX } = await import('../lib/auth/permissions');
    const unknownKeys = probes.map(p => p.key).filter(k => !(k in PERMISSION_MATRIX));
    if (unknownKeys.length > 0) {
      throw new Error(`Probes name permissions that do not exist: ${unknownKeys.join(', ')}`);
    }

    // =====================================================================
    // Run every probe as every role
    // =====================================================================
    for (const probe of probes) {
      process.stdout.write('  ');

      const denied = ALL_ROLES.filter(r => !can(principal(otherId, [r], sites), probe.key, probe.siteId));
      const allowed = ALL_ROLES.filter(r => can(principal(otherId, [r], sites), probe.key, probe.siteId));

      const outcome = async (role: RoleCode) => {
        const actor = { principal: principal(otherId, [role], sites), ip: null };
        try {
          await probe.run(actor);
          return { kind: 'OK', message: '' };
        } catch (e) {
          return { kind: errorKind(e), message: errorMessage(e) };
        }
      };

      // Denied roles first: none of them can mutate, so the state they all see
      // is the same one.
      const deniedResults = new Map<RoleCode, { kind: string; message: string }>();
      for (const role of denied) {
        deniedResults.set(role, await outcome(role));
        process.stdout.write('.');
      }

      // Then the permitted ones. Whether any of them succeeds tells us whether
      // the action was possible at all.
      let anySucceeded = false;
      for (const role of allowed) {
        const result = await outcome(role);
        checks++;

        if (result.kind === 'FORBIDDEN') {
          // A permitted role stopped by authorisation. Either the matrix and
          // the service disagree, or a segregation rule applied — the probe
          // cannot tell, so it reports and a human decides.
          failures.push({
            probe: `${probe.key} — ${probe.label}`, role,
            expected: 'past authorisation', got: `FORBIDDEN: ${result.message}`,
          });
          process.stdout.write('x');
        } else {
          if (result.kind === 'OK') anySucceeded = true;
          process.stdout.write('.');
        }
      }

      for (const role of denied) {
        const result = deniedResults.get(role)!;
        checks++;

        if (result.kind === 'OK') {
          // The only unconditional failure: a denied role got through.
          failures.push({
            probe: `${probe.key} — ${probe.label}`, role,
            expected: 'to be refused', got: 'the call SUCCEEDED',
          });
          process.stdout.write('X');
        } else if (anySucceeded && result.kind !== 'FORBIDDEN') {
          // The action WAS possible, so this role should have been stopped by
          // authorisation rather than by anything else.
          failures.push({
            probe: `${probe.key} — ${probe.label}`, role,
            expected: 'FORBIDDEN (the action was possible for others)',
            got: `${result.kind}: ${result.message}`,
          });
          process.stdout.write('X');
        }
      }

      console.log(`  ${probe.key}`);
    }

    console.log('');
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
  let setupFailed = false;
  try {
    await main();
  } catch (err) {
    console.error(`\n\n  Setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    setupFailed = true;
  } finally {
    process.stdout.write('  dropping the throwaway database … ');
    await dropTestDb();
    console.log('ok\n');
  }

  if (failures.length > 0) {
    console.log('  Failures:\n');
    for (const f of failures) {
      console.log(`  ✗ ${f.role} · ${f.probe}`);
      console.log(`      expected ${f.expected}`);
      console.log(`      got      ${f.got}\n`);
    }
  }

  const passed = checks - failures.length;
  console.log(`${passed}/${checks} role-and-action pairs behave as the matrix says\n`);
  process.exit(failures.length > 0 || setupFailed ? 1 : 0);
}

void run();
