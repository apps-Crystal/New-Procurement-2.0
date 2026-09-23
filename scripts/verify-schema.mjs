/**
 * Schema verification against a throwaway PostgreSQL 15.
 *
 * Proves that the supplied schema plus the two approved amendments apply
 * cleanly, and that the invariants the brief calls non-negotiable actually hold
 * in the database — not just in our code.
 *
 *   node scripts/verify-schema.mjs
 *
 * Requires Docker. Starts a container, runs the checks, removes it.
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = 'crystal-proc2-verify';
const PORT = 55432;
const PASSWORD = 'verify';

const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, message: err.message });
    failures++;
  }
}

/** Assert that `fn` throws, and that the message mentions `expect`. */
async function rejects(fn, expect, label) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(`${label}: expected the database to refuse this, but it succeeded`);
  const text = `${threw.message} ${threw.constraint_name ?? ''}`;
  if (expect && !text.toLowerCase().includes(expect.toLowerCase())) {
    throw new Error(`${label}: refused, but for the wrong reason — ${threw.message}`);
  }
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function startContainer() {
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' });
  } catch {
    /* not running */
  }
  process.stdout.write('  starting postgres:15 … ');
  sh('docker', [
    'run', '-d', '--name', CONTAINER,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e', 'POSTGRES_DB=crystal',
    '-p', `${PORT}:5432`,
    'postgres:15-alpine',
  ]);
  console.log('ok');
}

/**
 * Wait until the server actually answers a query.
 *
 * `pg_isready` is not enough: initdb starts a temporary server, runs the
 * bootstrap, then restarts. pg_isready says "ready" during that window and the
 * first real connection then fails with "the database system is starting up".
 */
async function waitReady() {
  process.stdout.write('  waiting for readiness … ');
  for (let i = 0; i < 90; i++) {
    const probe = postgres(`postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/crystal`, {
      max: 1,
      prepare: false,
      connect_timeout: 3,
      onnotice: () => {},
    });
    try {
      await probe`SELECT 1`;
      await probe.end({ timeout: 2 });
      console.log('ok');
      return;
    } catch {
      await probe.end({ timeout: 2 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('postgres did not answer a query within 90s');
}

function stopContainer() {
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

async function main() {
  startContainer();
  await waitReady();

  const sql = postgres(`postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/crystal`, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  try {
    // --- migrations ------------------------------------------------------------
    for (const file of ['0001_schema.sql', '0002_reference_data.sql']) {
      process.stdout.write(`  applying ${file} … `);
      await sql.unsafe(readFileSync(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      console.log('ok');
    }
    console.log('');

    // --- structure -------------------------------------------------------------
    await check('46 tables created', async () => {
      const [{ count }] = await sql`
        SELECT count(*)::int FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      if (count < 45) throw new Error(`only ${count} tables`);
    });

    await check('reporting views created', async () => {
      const views = (await sql`SELECT table_name FROM information_schema.views WHERE table_schema='public'`).map(r => r.table_name);
      for (const v of ['v_pr_totals', 'v_quotation_landed_cost', 'v_po_line_receipt', 'v_stock_position', 'v_group_surplus', 'v_vendor_scorecard']) {
        if (!views.includes(v)) throw new Error(`missing view ${v}`);
      }
    });

    // --- amendment C-01 ---------------------------------------------------------
    await check('C-01 · post_stock_movement keys on site_id', async () => {
      const [{ prosrc }] = await sql`SELECT prosrc FROM pg_proc WHERE proname = 'post_stock_movement'`;
      if (!prosrc.includes("p_movement || ':' || p_site_id")) {
        throw new Error('idempotency key does not include p_site_id');
      }
    });

    // --- amendment C-02 ---------------------------------------------------------
    await check('C-02 · qc_inspections allows re-inspection', async () => {
      const idx = (await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'qc_inspections'`).map(r => r.indexname);
      if (!idx.includes('qc_inspections_gi_original')) throw new Error('partial unique index missing');
      const [{ count }] = await sql`
        SELECT count(*)::int FROM pg_constraint
         WHERE conrelid = 'qc_inspections'::regclass AND contype = 'u'
           AND pg_get_constraintdef(oid) = 'UNIQUE (gate_inward_id)'`;
      if (count !== 0) throw new Error('the old UNIQUE (gate_inward_id) constraint is still present');
    });

    // --- reference data ----------------------------------------------------------
    await check('status_transitions seeded', async () => {
      const [{ count }] = await sql`SELECT count(*)::int FROM status_transitions`;
      if (count < 100) throw new Error(`only ${count} transitions seeded`);
    });

    await check('approval matrix seeded with ordered levels', async () => {
      const rows = await sql`
        SELECT b.entity_type, b.label, count(l.level_no)::int AS levels
          FROM approval_bands b JOIN approval_band_levels l ON l.band_id = b.id
         GROUP BY b.id, b.entity_type, b.label`;
      if (rows.length !== 10) throw new Error(`expected 10 bands with levels, got ${rows.length}`);
      const pr = rows.find(r => r.entity_type === 'PR' && r.label === 'Above ₹10 lakh');
      if (!pr || pr.levels !== 3) throw new Error('PR above ₹10 lakh should route through 3 levels');
    });

    await check('email_config seeded', async () => {
      const [{ count }] = await sql`SELECT count(*)::int FROM email_config`;
      if (count < 40) throw new Error(`only ${count} events seeded`);
    });

    // --- fixtures for the behavioural checks --------------------------------------
    const [site] = await sql`
      INSERT INTO sites (code, name, site_type, address, state_code, gstin, tally_cost_centre, status)
      VALUES ('DHU', 'Dhulagarh', 'WAREHOUSE', 'Dhulagarh, WB', '19', '19AABCU9603R1ZX', 'CC-DHU', 'ACTIVE')
      RETURNING id`;
    const [site2] = await sql`
      INSERT INTO sites (code, name, site_type, address, state_code, gstin, tally_cost_centre, status)
      VALUES ('PUN', 'Pune', 'WAREHOUSE', 'Pune, MH', '27', '27AABCU9603R1Z0', 'CC-PUN', 'ACTIVE')
      RETURNING id`;
    const [user] = await sql`
      INSERT INTO app_users (core_user_id, email, full_name) VALUES ('core-1', 'a@crystalgroup.in', 'Tester')
      RETURNING id`;
    const [cls] = await sql`
      INSERT INTO item_classes (code, name) VALUES ('AMB', 'Ambient') RETURNING id`;
    const [item] = await sql`
      INSERT INTO items (code, name, item_class_id, uom) VALUES ('PL-HDPE-12', 'HDPE pallet', ${cls.id}, 'Nos')
      RETURNING id`;

    // --- document numbering --------------------------------------------------------
    await check('next_document_no is atomic and formatted', async () => {
      const [a] = await sql`SELECT next_document_no('MR', 'DHU', '2026-09-23'::timestamptz) AS n`;
      const [b] = await sql`SELECT next_document_no('MR', 'DHU', '2026-09-23'::timestamptz) AS n`;
      if (a.n !== 'MR-DHU-Sep2026/0001') throw new Error(`unexpected format: ${a.n}`);
      if (b.n !== 'MR-DHU-Sep2026/0002') throw new Error(`did not increment: ${b.n}`);
    });

    // --- stock invariants ------------------------------------------------------------
    await check('stock posts through post_stock_movement', async () => {
      await sql`SELECT post_stock_movement(${site.id}, ${item.id}, 'GRN_RECEIPT', NULL, 'AVAILABLE', 100, 'GRN_LINE', 1, ${user.id})`;
      const [bal] = await sql`SELECT qty FROM stock_balances WHERE site_id=${site.id} AND item_id=${item.id} AND bucket='AVAILABLE'`;
      if (Number(bal.qty) !== 100) throw new Error(`balance is ${bal.qty}, expected 100`);
    });

    await check('replaying a movement posts once (idempotent)', async () => {
      await sql`SELECT post_stock_movement(${site.id}, ${item.id}, 'GRN_RECEIPT', NULL, 'AVAILABLE', 100, 'GRN_LINE', 1, ${user.id})`;
      const [bal] = await sql`SELECT qty FROM stock_balances WHERE site_id=${site.id} AND item_id=${item.id} AND bucket='AVAILABLE'`;
      if (Number(bal.qty) !== 100) throw new Error(`replay changed the balance to ${bal.qty}`);
      const [{ count }] = await sql`SELECT count(*)::int FROM stock_ledger WHERE source_type='GRN_LINE' AND source_id=1`;
      if (count !== 1) throw new Error(`${count} ledger rows for one source`);
    });

    await check('stock can never go negative', async () => {
      await rejects(
        () => sql`SELECT post_stock_movement(${site.id}, ${item.id}, 'ISSUE', 'AVAILABLE', NULL, 500, 'ISSUE_LINE', 1, ${user.id})`,
        'stock_balances_qty_check',
        'overdraw',
      );
    });

    await check('stock_ledger is append-only', async () => {
      await rejects(() => sql`UPDATE stock_ledger SET qty = 1 WHERE id = 1`, 'append-only', 'ledger update');
      await rejects(() => sql`DELETE FROM stock_ledger WHERE id = 1`, 'append-only', 'ledger delete');
    });

    await check('audit_log is append-only', async () => {
      await sql`INSERT INTO audit_log (entity_type, entity_id, action, user_id) VALUES ('MR', 1, 'CREATE', ${user.id})`;
      await rejects(() => sql`UPDATE audit_log SET action = 'X'`, 'append-only', 'audit update');
      await rejects(() => sql`DELETE FROM audit_log`, 'append-only', 'audit delete');
    });

    // --- C-01 in practice: a full transfer round-trip ------------------------------------
    await check('C-01 · transfer round-trip drains IN_TRANSIT and credits the destination', async () => {
      const [trf] = await sql`
        INSERT INTO stock_transfers (transfer_no, from_site_id, to_site_id, requested_by)
        VALUES (next_document_no('TRF','DHU'), ${site.id}, ${site2.id}, ${user.id}) RETURNING id`;
      const [line] = await sql`
        INSERT INTO stock_transfer_lines (transfer_id, item_id, qty) VALUES (${trf.id}, ${item.id}, 40)
        RETURNING id`;

      await sql`SELECT post_stock_movement(${site.id}, ${item.id}, 'TRANSFER_RESERVE', 'AVAILABLE', 'RESERVED', 40, 'TRANSFER_LINE', ${line.id}, ${user.id})`;
      await sql`SELECT post_stock_movement(${site.id}, ${item.id}, 'TRANSFER_OUT', 'RESERVED', 'IN_TRANSIT', 40, 'TRANSFER_LINE', ${line.id}, ${user.id})`;
      // Both legs of the receipt — this is what the old key made impossible.
      await sql`SELECT post_stock_movement(${site.id}, ${item.id}, 'TRANSFER_IN', 'IN_TRANSIT', NULL, 40, 'TRANSFER_LINE', ${line.id}, ${user.id})`;
      await sql`SELECT post_stock_movement(${site2.id}, ${item.id}, 'TRANSFER_IN', NULL, 'AVAILABLE', 40, 'TRANSFER_LINE', ${line.id}, ${user.id})`;

      const src = await sql`SELECT bucket, qty FROM stock_balances WHERE site_id=${site.id} AND item_id=${item.id}`;
      const dst = await sql`SELECT bucket, qty FROM stock_balances WHERE site_id=${site2.id} AND item_id=${item.id}`;
      const at = (rows, b) => Number(rows.find(r => r.bucket === b)?.qty ?? 0);

      if (at(src, 'IN_TRANSIT') !== 0) throw new Error(`source still holds ${at(src, 'IN_TRANSIT')} in transit`);
      if (at(src, 'AVAILABLE') !== 60) throw new Error(`source available is ${at(src, 'AVAILABLE')}, expected 60`);
      if (at(dst, 'AVAILABLE') !== 40) throw new Error(`destination available is ${at(dst, 'AVAILABLE')}, expected 40`);
    });

    // --- segregation of duties -------------------------------------------------------------
    await check('MR approver cannot be the requester', async () => {
      const [mr] = await sql`
        INSERT INTO material_requests (mr_no, site_id, category, required_by, urgency, requester_id)
        VALUES (next_document_no('MR','DHU'), ${site.id}, 'ASSETS', '2026-10-06', 'PLANNED', ${user.id})
        RETURNING id`;
      await rejects(
        () => sql`UPDATE material_requests SET approved_by = ${user.id} WHERE id = ${mr.id}`,
        'mr_self_approval',
        'self-approval',
      );
    });

    // --- generated columns and quantity integrity ---------------------------------------------
    await check('mr_lines.qty_purchase = requested − transfer', async () => {
      const [mr] = await sql`
        INSERT INTO material_requests (mr_no, site_id, category, required_by, urgency, requester_id)
        VALUES (next_document_no('MR','DHU'), ${site.id}, 'ASSETS', '2026-10-06', 'PLANNED', ${user.id})
        RETURNING id`;
      const [line] = await sql`
        INSERT INTO mr_lines (mr_id, line_no, item_id, qty_requested, qty_transfer)
        VALUES (${mr.id}, 1, ${item.id}, 5, 3) RETURNING qty_purchase`;
      if (Number(line.qty_purchase) !== 2) throw new Error(`qty_purchase is ${line.qty_purchase}, expected 2`);
      await rejects(
        () => sql`INSERT INTO mr_lines (mr_id, line_no, item_id, qty_requested, qty_transfer)
                  VALUES (${mr.id}, 2, ${item.id}, 5, 9)`,
        'mr_lines_transfer_le',
        'transfer exceeding request',
      );
    });

    // --- vendor rules -----------------------------------------------------------------------
    await check('vendor PAN/GSTIN rules and de-duplication', async () => {
      await sql`
        INSERT INTO vendors (vendor_code, legal_name, pan, gstin, state_code, address, tally_ledger_ref, status)
        VALUES ('V-0001', 'Northern Polymers', 'AABCU9603R', '19AABCU9603R1ZX', '19', 'Kolkata', 'LED-1', 'VENDOR_APPROVED')`;

      await rejects(
        () => sql`INSERT INTO vendors (vendor_code, legal_name, pan, state_code, address)
                  VALUES ('V-0002', 'Dup PAN', 'AABCU9603R', '19', 'Kolkata')`,
        'vendors_pan_uq',
        'duplicate PAN',
      );
      await rejects(
        () => sql`INSERT INTO vendors (vendor_code, legal_name, pan, gstin, state_code, address)
                  VALUES ('V-0003', 'Mismatch', 'AAACU9603R', '19AABCU9603R1ZX', '19', 'Kolkata')`,
        'vendors_gstin_pan',
        'GSTIN not containing PAN',
      );
      // The dedup index normalises with upper(btrim(...)), but the format CHECK
      // rejects anything not already normalised — so the app must upper/trim
      // BEFORE insert or the user gets a format error, not a duplicate error.
      // (Conflict register C-03.)
      await rejects(
        () => sql`INSERT INTO vendors (vendor_code, legal_name, pan, state_code, address)
                  VALUES ('V-0004', 'Lowercase', 'aabcu9603r', '19', 'Kolkata')`,
        'vendors_pan_format',
        'unnormalised PAN',
      );
    });

    await check('only approved vendors may appear on a PO', async () => {
      const [blocked] = await sql`
        INSERT INTO vendors (vendor_code, legal_name, pan, state_code, address, status, blocked_reason)
        VALUES ('V-0009', 'Blocked Co', 'AAECU9603R', '19', 'Kolkata', 'VENDOR_BLOCKED', 'Quality')
        RETURNING id`;
      const [mr] = await sql`
        INSERT INTO material_requests (mr_no, site_id, category, required_by, urgency, requester_id)
        VALUES (next_document_no('MR','DHU'), ${site.id}, 'ASSETS', '2026-10-06', 'PLANNED', ${user.id}) RETURNING id`;
      const [bc] = await sql`
        INSERT INTO budget_codes (code, financial_year) VALUES ('BUD-1', 'FY26-27') RETURNING id`;
      const [pr] = await sql`
        INSERT INTO purchase_requests (pr_no, mr_id, site_id, category, budget_code_id, procurement_type, purpose,
                                       urgency, expected_delivery, requester_id, pay_advance_pct, pay_post_delivery_pct)
        VALUES (next_document_no('PR','DHU'), ${mr.id}, ${site.id}, 'ASSETS', ${bc.id}, 'MATERIAL', 'Test',
                'PLANNED', '2026-10-06', ${user.id}, 30, 70)
        RETURNING id`;
      await rejects(
        () => sql`INSERT INTO purchase_orders (po_no, pr_id, vendor_id, site_id, expected_delivery, buyer_id)
                  VALUES (next_document_no('PO','DHU'), ${pr.id}, ${blocked.id}, ${site.id}, '2026-10-06', ${user.id})`,
        'only approved vendors',
        'blocked vendor on PO',
      );
    });

    // --- PR rules ---------------------------------------------------------------------------
    await check('PR payment terms must total 100%', async () => {
      const [mr] = await sql`
        INSERT INTO material_requests (mr_no, site_id, category, required_by, urgency, requester_id)
        VALUES (next_document_no('MR','DHU'), ${site.id}, 'ASSETS', '2026-10-06', 'PLANNED', ${user.id}) RETURNING id`;
      const [bc] = await sql`SELECT id FROM budget_codes LIMIT 1`;
      await rejects(
        () => sql`INSERT INTO purchase_requests (pr_no, mr_id, site_id, category, budget_code_id, procurement_type,
                                                 purpose, urgency, expected_delivery, requester_id, pay_advance_pct)
                  VALUES (next_document_no('PR','DHU'), ${mr.id}, ${site.id}, 'ASSETS', ${bc.id}, 'MATERIAL',
                          'Test', 'PLANNED', '2026-10-06', ${user.id}, 40)`,
        'pr_payment_terms_total',
        'payment terms not totalling 100',
      );
    });

    // --- declaration allocation --------------------------------------------------------------
    await check('declaration allocation must total 100%', async () => {
      const [mr] = await sql`
        INSERT INTO material_requests (mr_no, site_id, category, required_by, urgency, requester_id)
        VALUES (next_document_no('MR','DHU'), ${site.id}, 'ASSETS', '2026-10-06', 'PLANNED', ${user.id}) RETURNING id`;
      const [bc] = await sql`SELECT id FROM budget_codes LIMIT 1`;
      const [decl] = await sql`
        INSERT INTO mr_declarations (mr_id, business_impact, budget_code_id, estimated_value,
                                     declaration_text_version, accepted_by)
        VALUES (${mr.id}, ${'Freezer room 3 is running on one evaporator after a coil failure.'},
                ${bc.id}, 182000, 'v2.0', ${user.id})
        RETURNING id`;
      await rejects(
        () => sql.begin(tx => tx`INSERT INTO mr_allocations (declaration_id, site_id, cost_head, pct)
                                 VALUES (${decl.id}, ${site.id}, 'Freezer block', 70)`),
        'must total 100',
        '70% allocation',
      );
      // 70 + 30 in one transaction is accepted, because the trigger is deferred.
      await sql.begin(async tx => {
        await tx`INSERT INTO mr_allocations (declaration_id, site_id, cost_head, pct) VALUES (${decl.id}, ${site.id}, 'Freezer block', 70)`;
        await tx`INSERT INTO mr_allocations (declaration_id, site_id, cost_head, pct) VALUES (${decl.id}, ${site.id}, 'Chiller plant', 30)`;
      });
    });

    // --- receiving chain: gate inward -> QC, with the real constraints ---------------------------
    // Built once and reused by the checks below, because these rules only bite
    // on a complete PO -> GI -> QC chain.
    let giLine = null;
    let receiver = null;
    let inspector = null;

    await check('receiving chain builds (PO -> gate inward -> QC)', async () => {
      const [v] = await sql`SELECT id FROM vendors WHERE vendor_code = 'V-0001'`;
      const [bc] = await sql`SELECT id FROM budget_codes LIMIT 1`;
      [receiver] = await sql`
        INSERT INTO app_users (core_user_id, email, full_name) VALUES ('core-rcv', 'rcv@crystalgroup.in', 'Receiver')
        RETURNING id`;
      [inspector] = await sql`
        INSERT INTO app_users (core_user_id, email, full_name) VALUES ('core-qc', 'qc@crystalgroup.in', 'Inspector')
        RETURNING id`;

      const [mr] = await sql`
        INSERT INTO material_requests (mr_no, site_id, category, required_by, urgency, requester_id)
        VALUES (next_document_no('MR','DHU'), ${site.id}, 'ASSETS', '2026-10-06', 'PLANNED', ${user.id}) RETURNING id`;
      const [mrLine] = await sql`
        INSERT INTO mr_lines (mr_id, line_no, item_id, qty_requested, qty_transfer)
        VALUES (${mr.id}, 1, ${item.id}, 500, 0) RETURNING id, qty_purchase`;
      const [pr] = await sql`
        INSERT INTO purchase_requests (pr_no, mr_id, site_id, category, budget_code_id, procurement_type, purpose,
                                       urgency, expected_delivery, requester_id, pay_advance_pct, pay_post_delivery_pct)
        VALUES (next_document_no('PR','DHU'), ${mr.id}, ${site.id}, 'ASSETS', ${bc.id}, 'MATERIAL', 'Pallets',
                'PLANNED', '2026-10-06', ${user.id}, 20, 80) RETURNING id`;
      const [prLine] = await sql`
        INSERT INTO pr_lines (pr_id, line_no, mr_line_id, item_id, qty, est_rate, gst_rate)
        VALUES (${pr.id}, 1, ${mrLine.id}, ${item.id}, ${mrLine.qty_purchase}, 2150, 18) RETURNING id`;
      const [po] = await sql`
        INSERT INTO purchase_orders (po_no, pr_id, vendor_id, site_id, tally_po_ref, expected_delivery, buyer_id, status)
        VALUES (next_document_no('PO','DHU'), ${pr.id}, ${v.id}, ${site.id}, 'TALLY-PO-1', '2026-10-06', ${user.id}, 'PO_CREATED')
        RETURNING id`;
      const [poLine] = await sql`
        INSERT INTO po_lines (po_id, line_no, pr_line_id, item_id, qty_ordered, rate, gst_rate)
        VALUES (${po.id}, 1, ${prLine.id}, ${item.id}, 500, 2150, 18) RETURNING id`;
      const [gi] = await sql`
        INSERT INTO gate_inwards (gi_no, po_id, site_id, vehicle_no, challan_no, challan_date, received_by, status)
        VALUES (next_document_no('GI','DHU'), ${po.id}, ${site.id}, 'WB11C4821', 'NPP/DC/5521', '2026-09-26', ${receiver.id}, 'QC_PENDING')
        RETURNING id`;
      [giLine] = await sql`
        INSERT INTO gate_inward_lines (gate_inward_id, po_line_id, qty_per_challan, qty_counted)
        VALUES (${gi.id}, ${poLine.id}, 500, 500) RETURNING id, gate_inward_id, qty_short`;
      if (Number(giLine.qty_short) !== 0) throw new Error('qty_short should be 0 when counted matches challan');
    });

    await check('vehicle number must be unspaced (C-03)', async () => {
      const [po] = await sql`SELECT id FROM purchase_orders LIMIT 1`;
      await rejects(
        () => sql`INSERT INTO gate_inwards (gi_no, po_id, site_id, vehicle_no, challan_no, challan_date, received_by)
                  VALUES (next_document_no('GI','DHU'), ${po.id}, ${site.id}, 'WB 11 C 4821', 'DC/9', '2026-09-26', ${receiver.id})`,
        'gi_vehicle_format',
        'spaced vehicle number',
      );
    });

    await check('duplicate active challan per PO is blocked', async () => {
      const [po] = await sql`SELECT id FROM purchase_orders LIMIT 1`;
      await rejects(
        () => sql`INSERT INTO gate_inwards (gi_no, po_id, site_id, vehicle_no, challan_no, challan_date, received_by)
                  VALUES (next_document_no('GI','DHU'), ${po.id}, ${site.id}, 'WB11C9999', 'NPP/DC/5521', '2026-09-26', ${receiver.id})`,
        'gate_inwards_challan_uq',
        'duplicate challan',
      );
    });

    await check('QC inspector cannot be the gate receiver', async () => {
      await rejects(
        () => sql`INSERT INTO qc_inspections (qc_no, gate_inward_id, inspector_id, sla_due_at)
                  VALUES (next_document_no('QC','DHU'), ${giLine.gate_inward_id}, ${receiver.id}, now() + interval '48 hours')`,
        'Inspector cannot be the user who logged the gate inward',
        'receiver inspecting',
      );
    });

    await check('QC quantities must balance and give a reason', async () => {
      const [cl] = await sql`
        INSERT INTO qc_checklists (item_class_id, version) VALUES (${cls.id}, 'HDPE-PAL v3') RETURNING id`;
      const [qc] = await sql`
        INSERT INTO qc_inspections (qc_no, gate_inward_id, inspector_id, sla_due_at)
        VALUES (next_document_no('QC','DHU'), ${giLine.gate_inward_id}, ${inspector.id}, now() + interval '48 hours')
        RETURNING id`;

      // 480 + 0 + 10 != 500
      await rejects(
        () => sql`INSERT INTO qc_lines (qc_id, gate_inward_line_id, checklist_id, qty_delivered, qty_accepted, qty_hold, qty_rejected, reason_code)
                  VALUES (${qc.id}, ${giLine.id}, ${cl.id}, 500, 480, 0, 10, 'Physical damage')`,
        'qc_lines_sum',
        'unbalanced QC line',
      );
      // Rejecting without a reason
      await rejects(
        () => sql`INSERT INTO qc_lines (qc_id, gate_inward_line_id, checklist_id, qty_delivered, qty_accepted, qty_hold, qty_rejected)
                  VALUES (${qc.id}, ${giLine.id}, ${cl.id}, 500, 480, 0, 20)`,
        'qc_lines_reason',
        'rejection without a reason',
      );
      // Balanced, with a reason
      await sql`
        INSERT INTO qc_lines (qc_id, gate_inward_line_id, checklist_id, qty_delivered, qty_accepted, qty_hold, qty_rejected, reason_code)
        VALUES (${qc.id}, ${giLine.id}, ${cl.id}, 500, 480, 0, 20, 'Physical damage')`;
    });

    await check('C-02 · a re-inspection of the same gate inward is allowed', async () => {
      const [original] = await sql`SELECT id FROM qc_inspections WHERE gate_inward_id = ${giLine.gate_inward_id} AND is_reinspection_of IS NULL`;
      // A second ORIGINAL inspection is still refused …
      await rejects(
        () => sql`INSERT INTO qc_inspections (qc_no, gate_inward_id, inspector_id, sla_due_at)
                  VALUES (next_document_no('QC','DHU'), ${giLine.gate_inward_id}, ${inspector.id}, now() + interval '48 hours')`,
        'qc_inspections_gi_original',
        'second original inspection',
      );
      // … but a re-inspection is accepted. Under the schema as supplied this
      // insert was impossible, which made is_reinspection_of unreachable.
      await sql`
        INSERT INTO qc_inspections (qc_no, gate_inward_id, inspector_id, sla_due_at, is_reinspection_of)
        VALUES (next_document_no('QC','DHU'), ${giLine.gate_inward_id}, ${inspector.id}, now() + interval '48 hours', ${original.id})`;
    });

    await check('GRN approver cannot be the receiver or the inspector', async () => {
      const [qc] = await sql`SELECT id FROM qc_inspections WHERE is_reinspection_of IS NULL LIMIT 1`;
      const [po] = await sql`SELECT id FROM purchase_orders LIMIT 1`;
      const [grn] = await sql`
        INSERT INTO grns (grn_no, po_id, gate_inward_id, qc_id, site_id)
        VALUES (next_document_no('GRN','DHU'), ${po.id}, ${giLine.gate_inward_id}, ${qc.id}, ${site.id})
        RETURNING id`;
      const [poLine] = await sql`SELECT id FROM po_lines LIMIT 1`;
      const [qcLine] = await sql`SELECT id FROM qc_lines LIMIT 1`;
      await sql`
        INSERT INTO grn_lines (grn_id, po_line_id, qc_line_id, qty_accepted, unit_rate)
        VALUES (${grn.id}, ${poLine.id}, ${qcLine.id}, 480, 2150)`;
      await rejects(
        () => sql`UPDATE grns SET approved_by = ${receiver.id} WHERE id = ${grn.id}`,
        'GRN approver must differ',
        'receiver approving',
      );
      await rejects(
        () => sql`UPDATE grns SET approved_by = ${inspector.id} WHERE id = ${grn.id}`,
        'GRN approver must differ',
        'inspector approving',
      );
      // A third person is accepted.
      await sql`UPDATE grns SET approved_by = ${user.id}, status = 'GRN_APPROVED', approved_at = now() WHERE id = ${grn.id}`;
    });

    await check('only approved GRNs count toward PO receipt', async () => {
      const [row] = await sql`SELECT qty_received, qty_outstanding FROM v_po_line_receipt LIMIT 1`;
      if (Number(row.qty_received) !== 480) throw new Error(`qty_received is ${row.qty_received}, expected 480`);
      if (Number(row.qty_outstanding) !== 20) throw new Error(`qty_outstanding is ${row.qty_outstanding}, expected 20`);
    });

    // --- GST ---------------------------------------------------------------------------------------

    await check('invoice GST is IGST or CGST+SGST, never both', async () => {
      const [v] = await sql`SELECT id FROM vendors WHERE vendor_code = 'V-0001'`;
      const [po] = await sql`SELECT id FROM purchase_orders LIMIT 1`;
      if (po) {
        await rejects(
          () => sql`INSERT INTO vendor_invoices (vendor_id, po_id, invoice_no, invoice_date, place_of_supply,
                                                 taxable_value, cgst, sgst, igst)
                    VALUES (${v.id}, ${po.id}, 'INV-1', '2026-09-26', '19', 1000, 90, 90, 180)`,
          'vi_tax_mode',
          'both GST modes',
        );
      }
    });

    await check('credit-note variance is computed and flagged above 2%', async () => {
      const [{ prosrc }] = await sql`SELECT prosrc FROM pg_proc WHERE proname = 'compute_cn_variance'`;
      if (!prosrc.includes('variance_pct > 2')) throw new Error('2% threshold not present');
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

console.log('\nCrystal Procurement 2.0 — schema verification\n');
try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  failures++;
} finally {
  stopContainer();
}

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n      ${r.message}`}`);
}
console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed\n`);
process.exit(failures > 0 ? 1 : 0);
