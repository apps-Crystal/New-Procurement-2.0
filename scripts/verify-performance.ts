/**
 * Performance against production-shaped volume.
 *
 *   npm run verify:performance
 *
 * The checks inside `verify:procurement` are smoke tests: they prove a query
 * has not acquired an accidental cross join, against a database holding a few
 * dozen rows. That is worth having and it is not a benchmark.
 *
 * This builds a database the size Crystal will actually run — twelve sites,
 * two thousand items, sixty thousand ledger entries, forty thousand audit rows
 * — and times the queries that a screen waits on. Each has a budget. Exceeding
 * one fails the run, and the actual figure is always printed, because a query
 * that has quietly gone from 40ms to 900ms is worth seeing before it reaches
 * the budget.
 *
 * Seeding is raw SQL rather than the services. Sixty thousand ledger entries
 * through `post_stock_movement()` would take an hour and prove nothing this
 * script is asking about — what is under test is how the READS behave when the
 * tables are large.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import type { Principal, RoleCode } from '../lib/auth/permissions';

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'crystal_procurement_verify_perf';

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

/** What the deployment is sized for. */
const VOLUME = {
  sites: 12,
  items: 2_000,
  vendors: 300,
  ledgerEntries: 60_000,
  auditRows: 40_000,
  purchaseOrders: 3_000,
  materialRequests: 2_000,
};

interface Timing {
  label: string;
  ms: number;
  budgetMs: number;
  rows: number;
}

const timings: Timing[] = [];

async function time(label: string, budgetMs: number, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  const result = await fn();
  const ms = Date.now() - started;

  const rows = Array.isArray(result) ? result.length : 1;
  timings.push({ label, ms, budgetMs, rows });

  const over = ms > budgetMs;
  process.stdout.write(
    `  ${over ? '✗' : '✓'} ${label.padEnd(44)} ${String(ms).padStart(6)}ms` +
      ` (budget ${budgetMs}ms, ${rows} rows)\n`,
  );
}

async function main() {
  console.log('\nCrystal Procurement 2.0 — performance at volume\n');

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

  const { sql } = await import('../lib/db');

  try {
    // =====================================================================
    // Seed, in SQL. generate_series does in one statement what a JS loop
    // would take minutes over.
    // =====================================================================
    const seedStarted = Date.now();
    process.stdout.write('  seeding … ');

    await sql`
      INSERT INTO app_users (core_user_id, email, full_name)
      SELECT 'perf-' || n, 'perf' || n || '@crystalgroup.in', 'Perf User ' || n
        FROM generate_series(1, 50) n`;

    await sql`
      INSERT INTO sites (code, name, site_type, address, state_code, gstin, tally_cost_centre, status)
      SELECT 'S' || lpad(n::text, 3, '0'),
             'Site ' || n,
             'WAREHOUSE',
             'Address ' || n,
             '19',
             -- A distinct, well-formed GSTIN per site: 19 + PAN-shaped + 1Z + check.
             '19AAAAA' || lpad(n::text, 4, '0') || 'A1Z5',
             'CC-' || n,
             'ACTIVE'
        FROM generate_series(1, ${VOLUME.sites}) n`;

    await sql`
      INSERT INTO item_classes (code, name)
      SELECT 'C' || lpad(n::text, 3, '0'), 'Class ' || n FROM generate_series(1, 20) n`;

    await sql`
      INSERT INTO items (code, name, item_class_id, uom, default_gst_rate)
      SELECT 'IT-' || lpad(n::text, 6, '0'),
             'Item ' || n,
             (SELECT id FROM item_classes ORDER BY id LIMIT 1 OFFSET (n % 20)),
             'Nos',
             18
        FROM generate_series(1, ${VOLUME.items}) n`;

    await sql`
      INSERT INTO vendors (vendor_code, legal_name, vendor_type, pan, state_code, address,
                           tally_ledger_ref, status, created_by)
      SELECT 'V-' || lpad(n::text, 5, '0'),
             'Vendor ' || n,
             'COMPANY',
             'AAAAA' || lpad(n::text, 4, '0') || 'A',
             '19',
             'Vendor address ' || n,
             CASE WHEN n % 10 = 0 THEN NULL ELSE 'TALLY-V-' || n END,
             (CASE WHEN n % 10 = 0 THEN 'VENDOR_PENDING' ELSE 'VENDOR_APPROVED' END)::vendor_status,
             (SELECT id FROM app_users ORDER BY id LIMIT 1)
        FROM generate_series(1, ${VOLUME.vendors}) n`;

    // Reorder levels on a tenth of the item/site pairs, so the "below reorder"
    // tile has real work to do rather than an empty table.
    await sql`
      INSERT INTO item_site_settings (site_id, item_id, reorder_level)
      SELECT s.id, i.id, 25
        FROM sites s
        JOIN items i ON i.id % 10 = 0`;

    await sql`
      INSERT INTO stock_balances (site_id, item_id, bucket, qty)
      SELECT s.id, i.id, 'AVAILABLE'::stock_bucket, (i.id % 200)::numeric
        FROM sites s
        JOIN items i ON i.id % 3 = 0`;

    await sql`
      INSERT INTO stock_ledger (entry_no, site_id, item_id, movement, from_bucket, to_bucket,
                                qty, source_type, source_id, idempotency_key, posted_by, posted_at)
      SELECT 'SL-PERF-' || n,
             (SELECT id FROM sites ORDER BY id LIMIT 1 OFFSET (n % ${VOLUME.sites})),
             (SELECT id FROM items ORDER BY id LIMIT 1 OFFSET (n % ${VOLUME.items})),
             'GRN_RECEIPT'::movement_type, NULL, 'AVAILABLE'::stock_bucket,
             ((n % 50) + 1)::numeric,
             'GRN_LINE', n,
             'PERF:' || n,
             (SELECT id FROM app_users ORDER BY id LIMIT 1),
             now() - (n || ' minutes')::interval
        FROM generate_series(1, ${VOLUME.ledgerEntries}) n`;

    await sql`
      INSERT INTO audit_log (entity_type, entity_id, action, from_status, to_status,
                             user_id, remarks, created_at)
      SELECT CASE n % 6
               WHEN 0 THEN 'MR' WHEN 1 THEN 'PR' WHEN 2 THEN 'PO'
               WHEN 3 THEN 'GRN' WHEN 4 THEN 'RTV' ELSE 'INVOICE' END,
             n,
             (CASE WHEN n % 97 = 0 THEN 'OVERRIDE' ELSE 'TRANSITION' END)::text,
             'FROM_' || (n % 5), 'TO_' || (n % 5),
             (SELECT id FROM app_users ORDER BY id LIMIT 1),
             'Seeded audit row ' || n,
             now() - (n || ' minutes')::interval
        FROM generate_series(1, ${VOLUME.auditRows}) n`;

    // Enough of the procurement chain for the tiles that count it.
    await sql`
      INSERT INTO budget_codes (code, financial_year, category)
      VALUES ('PERF', 'FY26-27', 'MAINTENANCE_CAPEX')`;

    await sql`
      INSERT INTO material_requests (mr_no, site_id, requester_id, category, required_by, urgency, status)
      SELECT 'MR-PERF-' || n,
             (SELECT id FROM sites ORDER BY id LIMIT 1 OFFSET (n % ${VOLUME.sites})),
             (SELECT id FROM app_users ORDER BY id LIMIT 1),
             'CONSUMABLES'::category_code, current_date + 30, 'ROUTINE'::urgency_code,
             (CASE WHEN n % 7 = 0 THEN 'MR_DECLARED' ELSE 'MR_APPROVED' END)::mr_status
        FROM generate_series(1, ${VOLUME.materialRequests}) n`;

    await sql`
      INSERT INTO purchase_requests (pr_no, mr_id, site_id, requester_id, budget_code_id,
                                     category, urgency, procurement_type, purpose,
                                     expected_delivery, pay_post_delivery_pct, status)
      SELECT 'PR-PERF-' || m.id, m.id, m.site_id, m.requester_id,
             (SELECT id FROM budget_codes LIMIT 1),
             'CONSUMABLES'::category_code, 'ROUTINE'::urgency_code,
             'MATERIAL'::procurement_type, 'Seeded for performance measurement',
             current_date + 30, 100,
             (CASE WHEN m.id % 5 = 0 THEN 'PR_SUBMITTED' ELSE 'PR_APPROVED' END)::pr_status
        FROM material_requests m`;

    await sql`
      INSERT INTO purchase_orders (po_no, pr_id, site_id, vendor_id, buyer_id,
                                   expected_delivery, freight_amount, tally_po_ref, status)
      SELECT 'PO-PERF-' || p.id, p.id, p.site_id,
             (SELECT id FROM vendors WHERE status = 'VENDOR_APPROVED' ORDER BY id LIMIT 1),
             p.requester_id, current_date + 30, 0,
             CASE WHEN p.id % 4 = 0 THEN NULL ELSE 'TALLY-PO-' || p.id END,
             (CASE WHEN p.id % 4 = 0 THEN 'PO_DRAFT' ELSE 'PO_CREATED' END)::po_status
        FROM purchase_requests p
       LIMIT ${VOLUME.purchaseOrders}`;

    await sql`
      INSERT INTO mr_lines (mr_id, line_no, item_id, qty_requested)
      SELECT m.id, 1,
             (SELECT id FROM items ORDER BY id LIMIT 1 OFFSET (m.id % ${VOLUME.items})),
             10
        FROM material_requests m`;

    await sql`
      INSERT INTO pr_lines (pr_id, line_no, mr_line_id, item_id, qty, est_rate, gst_rate)
      SELECT p.id, 1, l.id, l.item_id, l.qty_purchase, 1000, 18
        FROM purchase_requests p
        JOIN mr_lines l ON l.mr_id = p.mr_id`;

    await sql`
      INSERT INTO po_lines (po_id, pr_line_id, item_id, qty_ordered, rate, gst_rate, line_no)
      SELECT po.id, pl.id, pl.item_id, pl.qty, pl.est_rate, pl.gst_rate, 1
        FROM purchase_orders po
        JOIN pr_lines pl ON pl.pr_id = po.pr_id`;

    // The planner needs statistics, or every timing below measures a bad plan
    // rather than the query.
    await sql`ANALYZE`;

    console.log(`ok (${((Date.now() - seedStarted) / 1000).toFixed(1)}s)`);

    const counts = await sql<{ table_name: string; n: string }[]>`
      SELECT 'stock_ledger' AS table_name, count(*)::text AS n FROM stock_ledger
      UNION ALL SELECT 'audit_log', count(*)::text FROM audit_log
      UNION ALL SELECT 'stock_balances', count(*)::text FROM stock_balances
      UNION ALL SELECT 'purchase_orders', count(*)::text FROM purchase_orders
      UNION ALL SELECT 'items', count(*)::text FROM items`;

    console.log(`  ${counts.map(c => `${c.n} ${c.table_name}`).join(', ')}\n`);

    // =====================================================================
    // Measure
    // =====================================================================
    const dash = await import('../lib/services/dashboard');
    const inventory = await import('../lib/services/inventory');
    const auditView = await import('../lib/services/audit-trail');
    const approvals = await import('../lib/services/approvals');

    const [firstSite] = await sql<{ id: string }[]>`SELECT id FROM sites ORDER BY id LIMIT 1`;
    const siteId = Number(firstSite.id);

    const allSites = await sql<{ id: string; code: string; name: string }[]>`
      SELECT id, code, name FROM sites ORDER BY id`;

    const [user] = await sql<{ id: string }[]>`SELECT id FROM app_users ORDER BY id LIMIT 1`;

    const roles: RoleCode[] = ['CG_ADM'];
    const groupWide: Principal = {
      userId: Number(user.id),
      coreUserId: 'perf',
      email: 'perf@crystalgroup.in',
      fullName: 'Perf',
      sites: allSites.map(s => ({
        siteId: Number(s.id), siteCode: s.code, siteName: s.name, roles,
      })),
      roles,
      groupWide: true,
    };

    const siteScoped: Principal = {
      ...groupWide,
      roles: ['CG_SMGR'],
      groupWide: false,
      sites: [{ siteId, siteCode: allSites[0].code, siteName: allSites[0].name, roles: ['CG_SMGR'] }],
    };

    await time('dashboard, group-wide (6 queries)', 2500, () => dash.dashboard(groupWide));
    await time('dashboard, one site', 2500, () => dash.dashboard(siteScoped));
    await time('stock position, one site', 1200, () =>
      inventory.stockPosition(siteScoped, { siteId }));
    await time('stock ledger, newest 200', 800, () =>
      inventory.ledger(groupWide, { limit: 200 }));
    await time('stock ledger, one item', 800, () =>
      inventory.ledger(groupWide, { siteId, itemId: 3, limit: 200 }));
    await time('audit trail, newest 200', 800, () =>
      auditView.auditTrail(groupWide, { limit: 200 }));
    await time('audit trail, overrides only', 800, () =>
      auditView.auditTrail(groupWide, { action: 'OVERRIDE', limit: 200 }));
    await time('audit summary', 1500, () => auditView.auditSummary(groupWide));
    await time('approvals queue', 1000, () => approvals.pendingApprovals(groupWide));
    await time('expected deliveries', 1500, async () => {
      const po = await import('../lib/services/po');
      return po.expectedDeliveries(groupWide);
    });

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

  const over = timings.filter(t => t.ms > t.budgetMs);

  if (over.length > 0) {
    console.log('  Over budget:\n');
    for (const t of over) {
      console.log(`  ✗ ${t.label}: ${t.ms}ms against a ${t.budgetMs}ms budget`);
    }
    console.log('');
  }

  const slowest = [...timings].sort((a, b) => b.ms - a.ms)[0];
  if (slowest) {
    console.log(`  slowest: ${slowest.label} at ${slowest.ms}ms\n`);
  }

  console.log(`${timings.length - over.length}/${timings.length} queries within budget at volume\n`);
  process.exit(over.length > 0 || setupFailed ? 1 : 0);
}

void run();
