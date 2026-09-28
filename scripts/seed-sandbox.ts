/**
 * Make a bare database usable — enough master data and enough roles to raise a
 * material request and walk it forward.
 *
 *   npm run seed:sandbox -- apps@crystalgroup.in
 *
 * A freshly bootstrapped database has one site, one item and one administrator.
 * That is correct — `bootstrap:admin` deliberately does the minimum — but it is
 * not enough to exercise anything: CG_ADM cannot raise a material request
 * (MR.CREATE is CG_REQ / CG_SMGR, by segregation of duties), and there is
 * nothing to request.
 *
 * Everything below goes through the normal services, so every validation rule,
 * every permission check and every constraint still applies. Nothing here is a
 * back door — it is the same calls a person would make through the screens,
 * made in one go.
 *
 * DEVELOPMENT ONLY. Refuses to run against a database that already carries
 * real transactions, and safe to re-run: anything already present is left
 * alone rather than duplicated or overwritten.
 */
import { sql } from '../lib/db';
import {
  updateSite,
  createLocation,
  createItemClass,
  createItem,
  createBudgetCode,
  setItemSiteSettings,
  grantRole,
} from '../lib/services/masters';
import type { Principal, RoleCode } from '../lib/auth/permissions';

const email = process.argv[2]?.trim().toLowerCase();

if (!email || !email.includes('@')) {
  console.error('\nUsage: npm run seed:sandbox -- apps@crystalgroup.in\n');
  process.exit(1);
}

/**
 * The roles the named user ends up holding at the sandbox site.
 *
 * CG_REQ raises a material request, CG_SMGR declares and stock-checks it,
 * CG_BUY turns it into a purchase request and owns the vendor side — including
 * proposing bank details, which CG_ADM deliberately cannot do (it approves
 * them, and the schema's vba_maker_checker forbids being both).
 */
const ROLES: RoleCode[] = ['CG_REQ', 'CG_SMGR', 'CG_BUY'];

/**
 * Two item classes and the items under them. Ambient and cold-chain, because
 * the cold-chain path (temperature limits, QC SLA, data loggers) is most of
 * what makes this system different from a generic procurement tool.
 *
 * HSN codes are left unset on purpose. They are real tax classifications and
 * inventing plausible-looking ones would put fabricated regulatory data in a
 * database that people will later read as if it were true. The field is
 * nullable; fill it from the real item master when there is one.
 */
const CLASSES = [
  { code: 'AMB', name: 'Ambient', isColdChain: false },
  {
    code: 'FRZ', name: 'Frozen (-18C to -25C)', isColdChain: true,
    tempMinC: '-25', tempMaxC: '-18', requiresDataLogger: false,
  },
];

const ITEMS = [
  // code, name, class, uom, reorder level at the sandbox site
  ['STR-WRAP-500', 'Stretch wrap film 500mm x 23 micron', 'AMB', 'Roll', '40'],
  ['TAPE-BOPP-48', 'BOPP packing tape 48mm x 65m', 'AMB', 'Roll', '100'],
  ['GLV-CRYO-L', 'Cryogenic handling gloves, large', 'AMB', 'Pair', '25'],
  ['LED-TUBE-20W', 'LED tube light 20W 4ft', 'AMB', 'Nos', '30'],
  ['CASTOR-125', 'Trolley castor wheel 125mm swivel', 'AMB', 'Nos', '20'],
  ['THRM-BLK-PAL', 'Thermal pallet blanket, reflective', 'FRZ', 'Nos', '15'],
  ['DL-USB-1', 'Single-use USB temperature data logger', 'FRZ', 'Nos', '50'],
  ['ICEPK-500', 'Gel ice pack 500g', 'FRZ', 'Nos', '200'],
  ['INSBOX-40L', 'Insulated shipper box 40 litre', 'FRZ', 'Nos', '12'],
] as const;

const LOCATIONS = [
  { code: 'RCV', description: 'Receiving bay', isCold: false },
  { code: 'AMB-A1', description: 'Ambient rack A1', isCold: false },
  { code: 'FRZ-01', description: 'Freezer chamber 01', isCold: true },
  { code: 'QUAR', description: 'Quarantine hold', isCold: false },
];

/** April-to-March, the Indian financial year this date falls in. */
function financialYear(on = new Date()): string {
  const y = on.getFullYear();
  const start = on.getMonth() >= 3 ? y : y - 1; // month 3 = April
  return `FY${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const BUDGETS = [
  { code: 'CAP-COLD', category: 'OPERATIONS_CAPEX', description: 'Cold chain operations capex' },
  { code: 'OPX-CONS', category: 'CONSUMABLES', description: 'Warehouse consumables' },
  { code: 'OPX-SVC', category: 'SERVICE', description: 'Services and AMC' },
];

async function main() {
  console.log('\nCrystal Procurement 2.0 — sandbox seed\n');

  // ---- Refuse to touch a database that is actually in use -------------------
  const [busy] = await sql<{ n: string }[]>`
    SELECT (SELECT count(*) FROM material_requests)
         + (SELECT count(*) FROM purchase_orders)
         + (SELECT count(*) FROM grns) AS n`;

  if (Number(busy.n) > 0) {
    console.error(`  This database already has ${busy.n} transaction(s) on it.`);
    console.error('  seed:sandbox is for an empty development database only. Stopping.\n');
    process.exit(1);
  }

  // ---- Who is acting --------------------------------------------------------
  const [user] = await sql<{ id: string; full_name: string }[]>`
    SELECT id, full_name FROM app_users WHERE lower(email) = ${email}`;

  if (!user) {
    console.error(`  No user ${email}. Run:  npm run bootstrap:admin -- ${email}\n`);
    process.exit(1);
  }

  const userId = Number(user.id);
  const grants = await sql<{ role: string }[]>`
    SELECT role FROM user_site_roles WHERE user_id = ${userId}`;

  if (!grants.some(g => g.role === 'CG_ADM')) {
    console.error(`  ${email} is not CG_ADM, so it cannot create master data.`);
    console.error(`  Run:  npm run bootstrap:admin -- ${email}\n`);
    process.exit(1);
  }

  // Accurate: this IS the administrator, acting as themselves.
  const principal: Principal = {
    userId,
    coreUserId: `seed:${email}`,
    email,
    fullName: user.full_name ?? email,
    sites: [],
    roles: ['CG_ADM'],
    groupWide: true,
  };
  const actor = { principal, ip: null };

  // ---- The site -------------------------------------------------------------
  const [site] = await sql<{ id: string; code: string; name: string; status: string; tally_cost_centre: string | null }[]>`
    SELECT id, code, name, status, tally_cost_centre FROM sites ORDER BY id LIMIT 1`;

  if (!site) {
    console.error('  No sites. Run bootstrap:admin with --site first.\n');
    process.exit(1);
  }

  const siteId = Number(site.id);
  console.log(`  Site ${site.code} — ${site.name}`);

  if (site.status !== 'ACTIVE') {
    // A site cannot go ACTIVE without a Tally cost centre; the constraint
    // sites_active_needs_mapping enforces it, and so does normaliseSite.
    await updateSite(actor, siteId, {
      tallyCostCentre: site.tally_cost_centre ?? `CC-${site.code}`,
      status: 'ACTIVE',
    });
    console.log(`    activated, Tally cost centre CC-${site.code}`);
  } else {
    console.log('    already active');
  }

  // ---- Roles ----------------------------------------------------------------
  console.log(`\n  Roles for ${email} at ${site.code}`);
  for (const role of ROLES) {
    if (grants.some(g => g.role === role)) {
      console.log(`    ${role} already held`);
      continue;
    }
    await grantRole(actor, { userId, siteId, role });
    console.log(`    ${role} granted`);
  }

  // ---- Item classes ---------------------------------------------------------
  console.log('\n  Item classes');
  const classIds = new Map<string, number>();
  for (const c of CLASSES) {
    const [existing] = await sql<{ id: string }[]>`SELECT id FROM item_classes WHERE code = ${c.code}`;
    if (existing) {
      classIds.set(c.code, Number(existing.id));
      console.log(`    ${c.code} already there`);
      continue;
    }
    const row = await createItemClass(actor, c);
    classIds.set(c.code, Number(row.id));
    console.log(`    ${c.code} — ${c.name}`);
  }

  // ---- Storage locations ----------------------------------------------------
  console.log('\n  Storage locations');
  for (const l of LOCATIONS) {
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM storage_locations WHERE site_id = ${siteId} AND code = ${l.code}`;
    if (existing) {
      console.log(`    ${l.code} already there`);
      continue;
    }
    await createLocation(actor, { siteId, ...l, status: 'ACTIVE' });
    console.log(`    ${l.code} — ${l.description}`);
  }

  // ---- Items, and what counts as low stock for each -------------------------
  console.log('\n  Items');
  for (const [code, name, cls, uom, reorder] of ITEMS) {
    let [item] = await sql<{ id: string }[]>`SELECT id FROM items WHERE code = ${code}`;

    if (!item) {
      const row = await createItem(actor, {
        code, name, itemClassId: classIds.get(cls)!, uom, status: 'ACTIVE',
      });
      item = { id: String(row.id) };
      console.log(`    ${code.padEnd(14)} ${name}`);
    } else {
      console.log(`    ${code.padEnd(14)} already there`);
    }

    // Idempotent by its composite primary key.
    await setItemSiteSettings(actor, {
      itemId: Number(item.id), siteId, reorderLevel: reorder,
    });
  }

  // The one item bootstrap:admin created gets a reorder level too, so it shows
  // up on the dashboard alongside the rest instead of looking broken.
  const [pallet] = await sql<{ id: string }[]>`SELECT id FROM items WHERE code = 'PL-HDPE-12'`;
  if (pallet) await setItemSiteSettings(actor, { itemId: Number(pallet.id), siteId, reorderLevel: '10' });

  // ---- Budget codes ---------------------------------------------------------
  const fy = financialYear();
  console.log(`\n  Budget codes (${fy})`);
  for (const b of BUDGETS) {
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM budget_codes WHERE code = ${b.code} AND financial_year = ${fy}`;
    if (existing) {
      console.log(`    ${b.code} already there`);
      continue;
    }
    await createBudgetCode(actor, { ...b, financialYear: fy, siteId, isActive: true });
    console.log(`    ${b.code.padEnd(9)} ${b.description}`);
  }

  console.log(`
  Done. Sign in as ${email} and go to Procurement -> Material requests;
  "Raise a request" is now there.

  You now hold CG_ADM, CG_REQ, CG_SMGR and CG_BUY. That is far more than one
  person should have in production -- segregation of duties is enforced
  server-side, so some steps (receiving then inspecting the same goods,
  approving bank details you proposed yourself) will still refuse. That is
  the system working, not a bug.
`);

  await sql.end({ timeout: 5 });
}

void main().catch(async err => {
  console.error('\n  Seed failed:', err instanceof Error ? err.message : err, '\n');
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
