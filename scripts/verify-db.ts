/**
 * Verification against a real PostgreSQL, through the real service layer.
 *
 *   npm run verify:db
 *
 * Creates a throwaway database, applies every migration, exercises the actual
 * modules — masters, vendors, stock — and drops it again. Zero residue, so it
 * is safe to run against a working server at any time.
 *
 * This is the counterpart to `verify:schema`, which proves the SQL applies and
 * its constraints bite. This one proves the application composes them
 * correctly: that a service reaches the constraint, and that the constraint's
 * refusal reaches the user as a sentence rather than a SQLSTATE.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import type { Principal, RoleCode } from '../lib/auth/permissions';

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'crystal_procurement_verify';

const baseUrl = process.env.ADMIN_URL ?? process.env.DATABASE_URL;
if (!baseUrl || baseUrl.includes('<PASSWORD>')) {
  console.error('\n  Set ADMIN_URL in .env.local (and replace the <PASSWORD> placeholder).\n');
  process.exit(1);
}

const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';

const testUrl = new URL(baseUrl);
testUrl.pathname = `/${TEST_DB}`;

// lib/db.ts creates its client lazily on first use, so pointing it at the
// throwaway database before anything imports it is enough.
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
  console.log('\nCrystal Procurement 2.0 — database verification\n');

  // --- throwaway database ---------------------------------------------------
  const admin = postgres(adminUrl.toString(), { ssl: false, max: 1, onnotice: () => {} });
  try {
    process.stdout.write(`  creating ${TEST_DB} … `);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
    console.log('ok');
  } finally {
    await admin.end({ timeout: 5 });
  }

  // --- migrations -----------------------------------------------------------
  const migrator = postgres(testUrl.toString(), { ssl: false, max: 1, onnotice: () => {} });
  try {
    const files = readdirSync(path.join(ROOT, 'db', 'migrations'))
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      process.stdout.write(`  applying ${file} … `);
      await migrator.unsafe(readFileSync(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      console.log('ok');
    }
  } finally {
    await migrator.end({ timeout: 5 });
  }

  console.log('');

  // Imported after DATABASE_URL is set.
  const { sql, inTransaction } = await import('../lib/db');
  const { createSite, updateSite, createItemClass, createItem, grantRole, publishChecklist, resolveApprovalBand } =
    await import('../lib/services/masters');
  const {
    createVendor, submitVendor, approveVendor, blockVendor, assertVendorOrderable,
    proposeBankAccount, approveBankAccount, listBankAccounts,
  } = await import('../lib/services/vendors');
  const { postMovement, receiveTransfer, balancesFor, idempotencyKey } = await import('../lib/services/stock');
  const { nextDocumentNo } = await import('../lib/doc-no');

  const makePrincipal = (userId: number, roles: RoleCode[], siteId: number): Principal => ({
    userId,
    coreUserId: `verify-${userId}`,
    email: `verify-${userId}@crystalgroup.in`,
    fullName: `Verifier ${userId}`,
    sites: [{ siteId, siteCode: 'ZZA', siteName: 'Verify A', roles }],
    roles,
    groupWide: roles.includes('CG_ADM'),
  });

  try {
    process.stdout.write('  ');

    // --- fixtures -----------------------------------------------------------
    const [maker] = await sql<{ id: string }[]>`
      INSERT INTO app_users (core_user_id, email, full_name)
      VALUES ('verify-maker', 'maker@crystalgroup.in', 'Maker') RETURNING id`;
    const [checker] = await sql<{ id: string }[]>`
      INSERT INTO app_users (core_user_id, email, full_name)
      VALUES ('verify-checker', 'checker@crystalgroup.in', 'Checker') RETURNING id`;

    const makerId = Number(maker.id);
    const checkerId = Number(checker.id);

    const bootstrapMaker = { principal: makePrincipal(makerId, ['CG_ADM', 'CG_ACC', 'CG_BUY'], 0), ip: null };

    const siteA = Number(
      (await createSite(bootstrapMaker, {
        code: 'ZZA', name: 'Verify A', siteType: 'WAREHOUSE', address: 'A',
        stateCode: '19', gstin: '19AABCU9603R1ZX', tallyCostCentre: 'CC-ZZA', status: 'ACTIVE',
      })).id,
    );
    const siteB = Number(
      (await createSite(bootstrapMaker, {
        code: 'ZZB', name: 'Verify B', siteType: 'WAREHOUSE', address: 'B',
        stateCode: '27', gstin: '27AABCU9603R1Z0', tallyCostCentre: 'CC-ZZB', status: 'ACTIVE',
      })).id,
    );

    const M = { principal: makePrincipal(makerId, ['CG_ADM', 'CG_ACC', 'CG_BUY'], siteA), ip: null };
    const C = { principal: makePrincipal(checkerId, ['CG_ADM', 'CG_FHEAD'], siteA), ip: null };

    const itemClassId = Number((await createItemClass(M, { code: 'ZZAMB', name: 'Verify ambient' })).id);
    const itemId = Number(
      (await createItem(M, { code: 'ZZ-ITEM-1', name: 'Verify item', itemClassId, uom: 'Nos' })).id,
    );

    // --- master data --------------------------------------------------------
    await check('refuses a duplicate site code', async () => {
      await rejects(
        () => createSite(M, {
          code: 'ZZA', name: 'Dup', siteType: 'DEPOT', address: 'x',
          stateCode: '19', gstin: '19AAFCU9603R1ZX', tallyCostCentre: 'CC-X',
        }),
        /already uses that code|already exists/i,
        'duplicate site code',
      );
    });

    await check('refuses a site whose GSTIN does not match its state', async () => {
      await rejects(
        () => createSite(M, {
          code: 'ZZD', name: 'Mismatch', siteType: 'DEPOT', address: 'x',
          stateCode: '27', gstin: '19AAGCU9603R1ZX', tallyCostCentre: 'CC-D',
        }),
        /belongs to West Bengal \(19\), but the state selected is Maharashtra \(27\)/,
        'GSTIN and state mismatch',
      );
    });

    await check('refuses to activate a site with no Tally cost centre', async () => {
      await rejects(
        () => createSite(M, {
          code: 'ZZE', name: 'No Tally', siteType: 'DEPOT', address: 'x',
          stateCode: '19', gstin: '19AAHCU9603R1ZX', status: 'ACTIVE',
        }),
        /cannot be activated until its Tally cost centre is recorded/,
        'activation without a Tally mapping',
      );
    });

    await check('refuses an item class with a broken temperature band', async () => {
      await rejects(
        () => createItemClass(M, { code: 'ZZCOLD', name: 'Bad band', isColdChain: true, tempMinC: '-15', tempMaxC: '-20' }),
        /minimum temperature must be below/,
        'inverted temperature band',
      );
    });

    await check('publishes a checklist and retires the previous current version', async () => {
      await publishChecklist(M, { itemClassId, version: 'V1', points: ['Dimensions', 'Markings'] });
      await publishChecklist(M, { itemClassId, version: 'V2', points: ['Dimensions', 'Markings', 'Label'] });

      const rows = await sql<{ version: string; is_current: boolean }[]>`
        SELECT version, is_current FROM qc_checklists WHERE item_class_id = ${itemClassId} ORDER BY version`;

      assertEqual(rows.map(r => [r.version, r.is_current]), [['V1', false], ['V2', true]], 'checklist versions');
    });

    await check('resolves the approval band and its ordered levels', async () => {
      const { band, levels } = await resolveApprovalBand('PR', '1500000');
      assertEqual(band.label, 'Above ₹10 lakh', 'band');
      assertEqual(levels.map(l => l.role), ['CG_SMGR', 'CG_FHEAD', 'CG_DIR'], 'levels');
    });

    await check('grants a role and makes it visible to the permission lookup', async () => {
      await grantRole(M, { userId: checkerId, siteId: siteA, role: 'CG_QC' });
      const rows = await sql`
        SELECT 1 FROM user_site_roles
         WHERE user_id = ${checkerId} AND site_id = ${siteA} AND role = 'CG_QC'`;
      assertEqual(rows.length, 1, 'grant present');

      // Granting twice is a no-op, not an error.
      await grantRole(M, { userId: checkerId, siteId: siteA, role: 'CG_QC' });
    });

    // --- document numbering -------------------------------------------------
    await check('document numbers format and increment atomically', async () => {
      const issued = await inTransaction(async tx => [
        await nextDocumentNo(tx, 'MR', 'ZZA'),
        await nextDocumentNo(tx, 'MR', 'ZZA'),
        await nextDocumentNo(tx, 'PR', 'ZZA'),
      ]);

      assert(/^MR-ZZA-\w+\/0001$/.test(issued[0]), `unexpected format: ${issued[0]}`);
      assert(/^MR-ZZA-\w+\/0002$/.test(issued[1]), `did not increment: ${issued[1]}`);
      assert(/^PR-ZZA-\w+\/0001$/.test(issued[2]), `series not independent: ${issued[2]}`);
    });

    await check('eight concurrent callers get eight distinct numbers', async () => {
      // The v1.0 read-increment-write race. INSERT … ON CONFLICT DO UPDATE …
      // RETURNING is one atomic statement, so concurrent callers serialise on
      // the row lock rather than losing each other's updates.
      const issued = await Promise.all(
        Array.from({ length: 8 }, () => inTransaction(tx => nextDocumentNo(tx, 'GRN', 'ZZA'))),
      );
      assertEqual(new Set(issued).size, 8, 'distinct numbers');

      const serials = issued.map(n => Number(n.split('/')[1])).sort((a, b) => a - b);
      assertEqual(serials, [1, 2, 3, 4, 5, 6, 7, 8], 'gapless serials');
    });

    await check('a rolled-back transaction leaves no document number behind', async () => {
      const before = await sql<{ last_serial: number }[]>`
        SELECT last_serial FROM id_counters WHERE entity = 'DMG' AND site_code = 'ZZA'`;

      await inTransaction(async tx => {
        await nextDocumentNo(tx, 'DMG', 'ZZA');
        throw new Error('deliberate rollback');
      }).catch(() => undefined);

      const after = await sql<{ last_serial: number }[]>`
        SELECT last_serial FROM id_counters WHERE entity = 'DMG' AND site_code = 'ZZA'`;

      assertEqual(after.length, before.length, 'counter row unchanged');
      if (before.length > 0) assertEqual(after[0].last_serial, before[0].last_serial, 'serial unchanged');
    });

    // --- stock --------------------------------------------------------------
    await check('posts a receipt to the ledger and the balance projection', async () => {
      const entryId = await inTransaction(tx =>
        postMovement(tx, {
          siteId: siteA, itemId, movement: 'GRN_RECEIPT', from: null, to: 'AVAILABLE',
          qty: '500', sourceType: 'GRN_LINE', sourceId: 1, userId: makerId, unitValue: '2150.00',
        }),
      );

      assert(entryId > 0, 'entry id returned');

      const [entry] = await sql<{ qty: string; entry_no: string; idempotency_key: string }[]>`
        SELECT qty, entry_no, idempotency_key FROM stock_ledger WHERE id = ${entryId}`;

      assertEqual(entry.qty, '500.000', 'quantity');
      assert(entry.entry_no.startsWith('SL-ZZA-'), 'entry number from next_document_no()');
      assertEqual(
        entry.idempotency_key,
        idempotencyKey({ sourceType: 'GRN_LINE', sourceId: 1, movement: 'GRN_RECEIPT', siteId: siteA }),
        'key includes site (amendment C-01)',
      );

      const balances = await inTransaction(tx => balancesFor(tx, siteA, itemId));
      assertEqual(balances.find(b => b.bucket === 'AVAILABLE')?.qty, '500.000', 'available');
    });

    await check('replaying a movement posts exactly once', async () => {
      const [{ count: before }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM stock_ledger`;

      await inTransaction(tx =>
        postMovement(tx, {
          siteId: siteA, itemId, movement: 'GRN_RECEIPT', from: null, to: 'AVAILABLE',
          qty: '500', sourceType: 'GRN_LINE', sourceId: 1, userId: makerId,
        }),
      );

      const [{ count: after }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM stock_ledger`;
      assertEqual(after, before, 'ledger row count unchanged');
    });

    await check('refuses to take stock below zero', async () => {
      await rejects(
        () => inTransaction(tx =>
          postMovement(tx, {
            siteId: siteA, itemId, movement: 'ISSUE', from: 'AVAILABLE', to: null,
            qty: '5000', sourceType: 'ISSUE_LINE', sourceId: 1, userId: makerId,
          }),
        ),
        /not enough stock|below zero/i,
        'overdraw',
      );

      const balances = await inTransaction(tx => balancesFor(tx, siteA, itemId));
      assertEqual(balances.find(b => b.bucket === 'AVAILABLE')?.qty, '500.000', 'balance untouched');
    });

    await check('C-01 · transfer round-trip drains IN_TRANSIT and credits the destination', async () => {
      await inTransaction(async tx => {
        await postMovement(tx, {
          siteId: siteA, itemId, movement: 'TRANSFER_RESERVE', from: 'AVAILABLE', to: 'RESERVED',
          qty: '200', sourceType: 'TRANSFER_LINE', sourceId: 1, userId: makerId,
        });
        await postMovement(tx, {
          siteId: siteA, itemId, movement: 'TRANSFER_OUT', from: 'RESERVED', to: 'IN_TRANSIT',
          qty: '200', sourceType: 'TRANSFER_LINE', sourceId: 1, userId: makerId,
        });
        await receiveTransfer(tx, {
          fromSiteId: siteA, toSiteId: siteB, itemId, qty: '200', transferLineId: 1, userId: makerId,
        });
      });

      const at = async (site: number, bucket: string) => {
        const rows = await inTransaction(tx => balancesFor(tx, site, itemId));
        return rows.find(b => b.bucket === bucket)?.qty ?? '0.000';
      };

      assertEqual(await at(siteA, 'IN_TRANSIT'), '0.000', 'source in-transit drained');
      assertEqual(await at(siteA, 'AVAILABLE'), '300.000', 'source available');
      assertEqual(await at(siteB, 'AVAILABLE'), '200.000', 'destination available');
    });

    await check('a failed step rolls back the stock it had already posted', async () => {
      // The guarantee the Sheets build could not offer at all.
      const [{ count: before }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM stock_ledger`;

      await inTransaction(async tx => {
        await postMovement(tx, {
          siteId: siteA, itemId, movement: 'GRN_RECEIPT', from: null, to: 'AVAILABLE',
          qty: '50', sourceType: 'GRN_LINE', sourceId: 999, userId: makerId,
        });
        throw new Error('deliberate rollback');
      }).catch(() => undefined);

      const [{ count: after }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM stock_ledger`;
      assertEqual(after, before, 'no ledger row survived the rollback');

      const balances = await inTransaction(tx => balancesFor(tx, siteA, itemId));
      assertEqual(balances.find(b => b.bucket === 'AVAILABLE')?.qty, '300.000', 'balance unchanged');
    });

    await check('the stock ledger is append-only', async () => {
      await rejects(() => sql`UPDATE stock_ledger SET qty = 1 WHERE id = 1`, /append-only/, 'ledger update');
      await rejects(() => sql`DELETE FROM stock_ledger WHERE id = 1`, /append-only/, 'ledger delete');
    });

    await check('the audit trail is append-only', async () => {
      await rejects(() => sql`UPDATE audit_log SET action = 'X'`, /append-only/, 'audit update');
      await rejects(() => sql`DELETE FROM audit_log`, /append-only/, 'audit delete');
    });

    await check('C-24 · site code freezes once the site has stock movements', async () => {
      // The supplied trigger checked only material_requests and
      // purchase_orders; migration 0003 widens it.
      await rejects(
        () => updateSite(M, siteA, { code: 'ZZX' }),
        /cannot change once transactions exist|cannot be changed/i,
        'site code change after transacting',
      );
    });

    // --- vendors ------------------------------------------------------------
    let vendorId = 0;

    await check('creates a vendor and allocates a vendor code', async () => {
      const vendor = await createVendor(M, {
        legalName: 'Northern Polymers & Packaging',
        pan: 'AABCU9603R',
        gstin: '19AABCU9603R1ZX',
        stateCode: '19',
        address: 'Dhulagarh, West Bengal',
        contactPhone: '9830012345',
      });
      vendorId = Number(vendor.id);
      assertEqual(vendor.vendor_code, 'V-0001', 'first vendor code');
      assertEqual(vendor.status, 'VENDOR_DRAFT', 'starts as a draft');
    });

    await check('refuses a duplicate PAN however it is typed', async () => {
      await rejects(
        () => createVendor(M, { legalName: 'Dup', pan: '  aabcu 9603r ', stateCode: '19', address: 'x' }),
        /already uses PAN AABCU9603R/,
        'duplicate PAN',
      );
    });

    await check('refuses a GSTIN that does not contain the PAN entered', async () => {
      await rejects(
        () => createVendor(M, {
          legalName: 'Mismatch', pan: 'AAZCU9603R', gstin: '19AABCU9603R1ZX', stateCode: '19', address: 'x',
        }),
        /contains the PAN AABCU9603R, which does not match/,
        'GSTIN not matching its PAN',
      );
    });

    await check('refuses to approve a vendor without a Tally ledger reference', async () => {
      await submitVendor(M, vendorId);
      await rejects(
        () => approveVendor(C, vendorId),
        /cannot be approved until their Tally ledger reference is recorded/,
        'approval without a ledger reference',
      );
    });

    await check('refuses to let the creator approve their own vendor', async () => {
      await rejects(() => approveVendor(M, vendorId, 'LEDGER-NP-01'), /cannot approve it/i, 'self-approval');
    });

    await check('a second person approves the vendor', async () => {
      const approved = await approveVendor(C, vendorId, 'LEDGER-NP-01');
      assertEqual(approved.status, 'VENDOR_APPROVED', 'status');
    });

    await check('only an approved vendor may be ordered from', async () => {
      await assertVendorOrderable(vendorId);
      await blockVendor(C, vendorId, 'Quality failures on three consecutive deliveries');
      await rejects(() => assertVendorOrderable(vendorId), /is blocked/, 'blocked vendor');
    });

    await check('an illegal state transition is refused', async () => {
      // VENDOR_BLOCKED -> VENDOR_PENDING is not a declared arrow.
      await rejects(() => submitVendor(M, vendorId), /cannot go from VENDOR_BLOCKED/, 'undeclared arrow');
    });

    // --- bank maker-checker -------------------------------------------------
    let bankId = 0;

    await check('proposes bank details with the account number encrypted', async () => {
      const account = await proposeBankAccount(M, {
        vendorId, accountNumber: '5011 2233 4455', ifsc: 'hdfc0001234',
        beneficiaryName: 'Northern Polymers & Packaging',
      });
      bankId = Number(account.id);

      assertEqual(account.state, 'PENDING', 'starts pending');
      assertEqual(account.account_last4, '4455', 'last four readable');
      assertEqual(account.ifsc, 'HDFC0001234', 'IFSC normalised');
      assert(!('account_number_enc' in account), 'ciphertext not returned');

      const [stored] = await sql<{ enc: string }[]>`
        SELECT encode(account_number_enc, 'escape') AS enc FROM vendor_bank_accounts WHERE id = ${bankId}`;
      assert(!stored.enc.includes('501122334455'), 'plaintext absent from the column');
      assert(stored.enc.startsWith('v1.'), 'stored in the versioned envelope');
    });

    await check('maker-checker: the proposer cannot approve their own bank details', async () => {
      await rejects(() => approveBankAccount(M, bankId), /cannot approve them/i, 'proposer approving');
    });

    await check('a second person approves the bank details', async () => {
      const approved = await approveBankAccount(C, bankId);
      assertEqual(approved.state, 'APPROVED', 'state');
    });

    await check('vba_one_live · only one bank account is live at a time', async () => {
      const second = await proposeBankAccount(M, {
        vendorId, accountNumber: '600099887766', ifsc: 'ICIC0004321',
        beneficiaryName: 'Northern Polymers & Packaging',
      });
      await approveBankAccount(C, Number(second.id));

      const live = await sql<{ account_last4: string }[]>`
        SELECT account_last4 FROM vendor_bank_accounts WHERE vendor_id = ${vendorId} AND state = 'APPROVED'`;

      assertEqual(live.length, 1, 'exactly one approved account');
      assertEqual(live[0].account_last4, '7766', 'the newest account is live');
    });

    await check('the list API never returns an account number', async () => {
      const accounts = await listBankAccounts(C, vendorId);
      assert(accounts.length >= 2, 'accounts returned');
      for (const a of accounts) assert(!('account_number_enc' in a), 'ciphertext stripped');
    });

    // --- audit --------------------------------------------------------------
    await check('every action left an audit row, with no account number in it', async () => {
      const rows = await sql<{ entity_type: string; before_data: unknown; after_data: unknown }[]>`
        SELECT entity_type, before_data, after_data FROM audit_log`;

      assert(rows.length >= 10, `expected a populated trail, found ${rows.length}`);
      assert(rows.some(r => r.entity_type === 'VENDOR'), 'vendor rows present');
      assert(rows.some(r => r.entity_type === 'VENDOR_BANK'), 'bank rows present');

      const serialised = JSON.stringify(rows);
      assert(!serialised.includes('501122334455'), 'plaintext account number absent');
      assert(!serialised.includes('v1.'), 'ciphertext absent');
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
