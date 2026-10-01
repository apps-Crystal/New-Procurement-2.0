/**
 * Architecture invariants.
 *
 * These test the rules the brief states as absolutes (§16, §26, §27, §30, §35).
 * They scan source rather than behaviour, because the point is that the wrong
 * code should never be written — not that it fails at runtime.
 *
 * Fast, no database, no network.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const SCANNED_DIRS = ['app', 'lib', 'components'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'prototype', 'docs', 'db']);

function sourceFiles(): { file: string; body: string }[] {
  const out: { file: string; body: string }[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push({ file: path.relative(ROOT, full).replace(/\\/g, '/'), body: readFileSync(full, 'utf8') });
      }
    }
  };

  for (const d of SCANNED_DIRS) {
    const full = path.join(ROOT, d);
    try {
      if (statSync(full).isDirectory()) walk(full);
    } catch {
      /* directory not created yet */
    }
  }
  return out;
}

/** Strip comments so documentation about a rule never trips the rule. */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('stock integrity (§16)', () => {
  const STOCK_SERVICE = 'lib/services/stock.ts';

  /**
   * The invariant is a single WRITER, not a single reader.
   *
   * Reading the ledger elsewhere is legitimate: masters.ts reads it to refuse
   * flipping an item to serialised once stock has moved. What must never happen
   * is a second piece of code WRITING either table — at that point
   * `stock_balances` stops being a faithful projection of `stock_ledger`.
   */
  it('nothing outside the stock service writes to stock_ledger or stock_balances', () => {
    const write = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(stock_ledger|stock_balances)\b/i;

    const offenders = sourceFiles()
      .filter(f => f.file !== STOCK_SERVICE)
      .filter(f => write.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });

  it('nothing outside the stock service calls post_stock_movement', () => {
    const offenders = sourceFiles()
      .filter(f => f.file !== STOCK_SERVICE)
      .filter(f => /post_stock_movement\s*\(/.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });
});

describe('document numbering (§30)', () => {
  const NUMBERING = 'lib/doc-no.ts';

  it('document numbers come only from next_document_no()', () => {
    const offenders = sourceFiles()
      .filter(f => f.file !== NUMBERING)
      .filter(f => /next_document_no\s*\(/.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });

  it('no document number is built by string concatenation in application code', () => {
    // Catches `'MR-' + site + …` and its template equivalent — the v1.0 bug
    // that id_counters and next_document_no() exist to prevent.
    const pattern =
      /['"`](MR|PR|PO|GI|QC|GRN|DMG|SHT|RTV|RGP|DN|TRF|SL|ISS)-\$\{|['"`](MR|PR|PO|GI|QC|GRN|DMG|SHT|RTV|RGP|DN|TRF|SL|ISS)-['"`]\s*\+/;

    const offenders = sourceFiles()
      .filter(f => pattern.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });
});

describe('data access (§27)', () => {
  it('client components never import the database', () => {
    const offenders = sourceFiles()
      .filter(f => /^\s*['"]use client['"]/m.test(f.body))
      .filter(f => /from\s+['"]@\/lib\/db['"]/.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });

  it('client components never import a service, crypto or the audit writer', () => {
    const offenders = sourceFiles()
      .filter(f => /^\s*['"]use client['"]/m.test(f.body))
      .filter(f => /from\s+['"]@\/lib\/(services\/|crypto|audit|doc-no)['"]?/.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });

  it('route handlers do not open transactions — services do', () => {
    const offenders = sourceFiles()
      .filter(f => /^app\/api\//.test(f.file))
      .filter(f => /\b(sql\.begin|inTransaction)\s*\(/.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });

  it('nothing still imports the retired Sheets layer', () => {
    const offenders = sourceFiles()
      .filter(f => /from\s+['"]@?\.{0,2}\/?lib\/sheets\//.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });
});

describe('money (§31)', () => {
  it('no service does arithmetic on parseFloat of a money value', () => {
    // numeric comes back from postgres.js as a string on purpose. A float here
    // is a wrong invoice; use lib/pg/decimal.ts, or let the database do it.
    const offenders = sourceFiles()
      .filter(f => /^lib\/(services|calc)\//.test(f.file))
      .filter(f => /parseFloat\s*\(/.test(code(f.body)))
      .map(f => f.file);

    expect(offenders).toEqual([]);
  });
});

describe('dashboard (§24)', () => {
  const DASHBOARD_UI = 'app/(app)/Dashboard.tsx';
  const DASHBOARD_SERVICE = 'lib/services/dashboard.ts';

  it('no dashboard figure is a hardcoded number', () => {
    const body = readFileSync(path.join(ROOT, DASHBOARD_UI), 'utf8');

    // The risk is a tile whose value is typed rather than fetched. Layout
    // numbers (gridTemplateColumns, rows={8}) are not that, so the check is
    // aimed at where a VALUE would sit: a JSX expression holding a bare number,
    // or a string of digits passed as one.
    const offenders = [
      ...body.matchAll(/value=\{\s*-?\d/g),
      ...body.matchAll(/value="\s*-?[\d,.]+\s*"/g),
      ...body.matchAll(/>\s*₹\s*[\d,.]+\s*</g),
    ].map(m => m[0]);

    expect(offenders).toEqual([]);
  });

  it('the dashboard renders only what the API gave it', () => {
    const body = readFileSync(path.join(ROOT, DASHBOARD_UI), 'utf8');

    // No arithmetic on metric values in the component: summing or averaging
    // here would produce a figure with no query behind it, which is exactly
    // what §24 forbids.
    expect(body).not.toMatch(/\.reduce\(/);
    expect(body).not.toMatch(/metric\.value\s*[-+*/]/);
    expect(body).not.toMatch(/Number\(\s*metric\.value/);
  });

  it('every metric names the query that produced it', async () => {
    const service = readFileSync(path.join(ROOT, DASHBOARD_SERVICE), 'utf8');

    // Each metric literal carries `query:`, and each group declares its query
    // name once as `const q = '...'`. If a metric were added without one, TS
    // would fail the build — this checks the names actually match the
    // exported functions rather than being decorative strings.
    const declared = [...service.matchAll(/const q = '(\w+)';/g)].map(m => m[1]);
    expect(declared.length).toBeGreaterThan(0);

    const dashboardModule = await import('@/lib/services/dashboard');
    for (const name of declared) {
      expect(typeof (dashboardModule as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('dashboard queries are site-scoped', () => {
    const service = readFileSync(path.join(ROOT, DASHBOARD_SERVICE), 'utf8');

    // Every group reads the caller's sites and applies them. A group that
    // forgot would quietly show a Site Manager the whole group's numbers while
    // every screen behind the tiles showed less.
    const groups = [...service.matchAll(/export async function (\w+Metrics)\(/g)].map(m => m[1]);
    expect(groups.length).toBeGreaterThanOrEqual(6);

    for (const group of groups) {
      const start = service.indexOf(`export async function ${group}(`);
      const end = service.indexOf('export async function', start + 1);
      const body = service.slice(start, end === -1 ? undefined : end);
      expect(body).toContain('scope(principal)');
    }
  });
});

describe('audit trail (§29)', () => {
  it('the audit viewer never writes', () => {
    const files = [
      'app/(app)/audit/AuditTrail.tsx',
      'lib/services/audit-trail.ts',
      'app/api/audit/route.ts',
    ].map(f => ({ file: f, body: readFileSync(path.join(ROOT, f), 'utf8') }));

    // audit_log carries forbid_mutation(), so a write would fail anyway — but
    // it should not be attempted, and no route should offer one.
    for (const { file, body } of files) {
      expect({ file, writes: /INSERT INTO audit_log|UPDATE audit_log|DELETE FROM audit_log/.test(body) })
        .toEqual({ file, writes: false });
      expect({ file, posts: /export const (POST|PATCH|PUT|DELETE)/.test(body) })
        .toEqual({ file, posts: false });
    }
  });
});

describe('navigation shortcuts', () => {
  /**
   * Only ever ONE current page.
   *
   * This shipped broken: a shortcut was current whenever every parameter it
   * NAMED was set, so /pr?stage=PR_SUBMITTED&new=1 -- which you get by opening
   * the form while a stage filter is on -- lit up both "Raise a request" and
   * "Approve requests" at once. The test is here rather than in the Sidebar
   * because nothing about it needs React, and because the same class of fault
   * (a nav rule that is silently wrong on screen) has now happened twice.
   */
  it('at most one shortcut is current, however the parameters combine', async () => {
    const { NAV, currentChildHref } = await import('@/lib/nav');

    const parents = NAV.flatMap(g => g.items).filter(i => (i.children ?? []).length > 0);
    expect(parents.length).toBeGreaterThan(0);

    for (const parent of parents) {
      const kids = parent.children ?? [];

      // Every combination of the parameters the shortcuts name, including the
      // combined ones no single shortcut asks for.
      const names = kids.flatMap(c => [...new URLSearchParams(c.href.split('?')[1] ?? '')]);

      for (let mask = 0; mask < 2 ** names.length; mask++) {
        const params = new URLSearchParams();
        names.forEach(([k, v], bit) => { if (mask & (1 << bit)) params.set(k, v); });

        const lit = currentChildHref(kids, parent.href, params);
        if (lit !== null) expect(kids.map(c => c.href)).toContain(lit);
      }
    }
  });

  it('a shortcut is not current on the bare screen, nor on another one', async () => {
    const { NAV, currentChildHref } = await import('@/lib/nav');
    const parents = NAV.flatMap(g => g.items).filter(i => (i.children ?? []).length > 0);

    for (const parent of parents) {
      const kids = parent.children ?? [];
      const bare = currentChildHref(kids, parent.href, new URLSearchParams());

      // Nothing with a query string may light up on the plain screen.
      if (bare !== null) expect(bare.includes('?')).toBe(false);

      // And nothing at all lights up on someone else's screen.
      expect(currentChildHref(kids, '/somewhere-else', new URLSearchParams('new=1'))).toBeNull();
    }
  });

  it('the most specific shortcut wins when several match', async () => {
    const { currentChildHref } = await import('@/lib/nav');

    const kids = [
      { href: '/pr?new=1', label: 'Raise', permission: 'PR.CREATE' as const },
      { href: '/pr?stage=PR_SUBMITTED', label: 'Approve', permission: 'PR.APPROVE' as const },
      { href: '/pr?stage=PR_SUBMITTED&mine=1', label: 'Mine to approve', permission: 'PR.APPROVE' as const },
    ];

    // One each.
    expect(currentChildHref(kids, '/pr', new URLSearchParams('new=1'))).toBe('/pr?new=1');

    // Both match on one parameter — the first listed wins, deterministically.
    expect(currentChildHref(kids, '/pr', new URLSearchParams('stage=PR_SUBMITTED&new=1'))).toBe('/pr?new=1');

    // Two parameters beat one, wherever it sits in the list.
    expect(currentChildHref(kids, '/pr', new URLSearchParams('stage=PR_SUBMITTED&mine=1')))
      .toBe('/pr?stage=PR_SUBMITTED&mine=1');
  });
});

describe('authorisation (§26, §31)', () => {
  it('permission keys used in navigation all exist in the matrix', async () => {
    const { PERMISSION_MATRIX } = await import('@/lib/auth/permissions');
    const { navItems } = await import('@/lib/nav');

    // navItems() includes the indented shortcuts, which name their own key —
    // a child asking for a permission that does not exist would be invisible
    // to everyone, silently, exactly like the quotation panel was.
    const unknown = navItems()
      .map(i => i.permission)
      .filter(p => !(p in PERMISSION_MATRIX));

    expect(unknown).toEqual([]);
  });

  it('every navigation link resolves to a page, unless marked as not yet built', async () => {
    const { navItems, navPath } = await import('@/lib/nav');
    const appDir = path.join(ROOT, 'app', '(app)');

    // A route group folder like (app) does not appear in the URL, and a
    // dynamic segment cannot be reached from a static nav href, so neither
    // needs handling here. A child's href carries a query string that puts the
    // screen into a state; the page it resolves to is the path before the '?'.
    const pageExists = (href: string) => {
      const p = navPath(href);
      const rel = p === '/' ? '' : p.slice(1);
      return statSync(path.join(appDir, rel, 'page.tsx'), { throwIfNoEntry: false }) !== undefined;
    };

    const broken = navItems()
      .filter(i => !i.comingIn && !pageExists(i.href))
      .map(i => i.href);

    expect(broken).toEqual([]);
  });

  it('nothing is marked as not yet built once its page exists', async () => {
    const { NAV } = await import('@/lib/nav');
    const appDir = path.join(ROOT, 'app', '(app)');

    // The other half of the rule: a stale marker hides a finished screen behind
    // a greyed-out label, which is worse than the 404 it was added to prevent.
    const stale = NAV.flatMap(g => g.items)
      .filter(
        i =>
          i.comingIn &&
          statSync(path.join(appDir, i.href.slice(1), 'page.tsx'), { throwIfNoEntry: false }) !== undefined,
      )
      .map(i => i.href);

    expect(stale).toEqual([]);
  });

  it('every permission key grants at least one role', async () => {
    const { PERMISSION_MATRIX } = await import('@/lib/auth/permissions');

    const empty = Object.entries(PERMISSION_MATRIX)
      .filter(([, roles]) => roles.length === 0)
      .map(([key]) => key);

    expect(empty).toEqual([]);
  });

  /**
   * A screen that tests a key which does not exist fails SILENTLY. `granted` is
   * a plain string array, so an unknown key is simply `false` — nothing throws,
   * nothing is logged, and the control is invisible to everybody in every
   * configuration.
   *
   * That is exactly what happened to the quotation panel: it asked for
   * QUOTATION.CREATE and QUOTATION.AWARD, which the matrix has never had, so
   * "Record a quotation" and "Award" could never render and the quotation step
   * was unreachable from the UI. `can()` logs an unknown key; this path cannot,
   * which is why it needs a test rather than a runtime guard.
   */
  it('every permission key a screen tests actually exists', async () => {
    const { PERMISSION_MATRIX } = await import('@/lib/auth/permissions');
    const known = new Set(Object.keys(PERMISSION_MATRIX));

    const offenders: string[] = [];
    const patterns = [
      /(?:granted|held)\s*\.(?:includes|has)\(\s*'([A-Z_]+\.[A-Z_]+)'\s*\)/g,
      /needs=\{?'([A-Z_]+\.[A-Z_]+)'/g, // <PermissionGate needs="…">
    ];

    for (const { file, body } of sourceFiles()) {
      if (!file.endsWith('.tsx')) continue;
      for (const re of patterns) {
        for (const m of code(body).matchAll(re)) {
          if (!known.has(m[1])) offenders.push(`${file}: ${m[1]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every permission_key in the reference data exists in the matrix', async () => {
    const { PERMISSION_MATRIX } = await import('@/lib/auth/permissions');
    const sql = readFileSync(path.join(ROOT, 'db/migrations/0002_reference_data.sql'), 'utf8');

    const keys = [...sql.matchAll(/'([A-Z_]+\.[A-Z_]+)'\)/g)].map(m => m[1]);
    expect(keys.length).toBeGreaterThan(50);

    const unknown = [...new Set(keys)].filter(k => !(k in PERMISSION_MATRIX));
    expect(unknown).toEqual([]);
  });
});

describe('schema fidelity', () => {
  it('every enum the application names exists in the schema', async () => {
    const { ENUMS } = await import('@/lib/enums');
    const schema = readFileSync(path.join(ROOT, 'db/migrations/0001_schema.sql'), 'utf8');

    const declared = new Set([...schema.matchAll(/CREATE TYPE\s+(\w+)\s+AS ENUM/g)].map(m => m[1]));

    // A few closed sets are application-level rather than SQL enums.
    const appOnly = new Set(['entity_type_approval', 'outbox_status', 'journal_status']);

    const missing = Object.keys(ENUMS).filter(name => !declared.has(name) && !appOnly.has(name));
    expect(missing).toEqual([]);
  });

  it('enum values match the schema exactly', async () => {
    const { ENUMS } = await import('@/lib/enums');
    const schema = readFileSync(path.join(ROOT, 'db/migrations/0001_schema.sql'), 'utf8');

    const drift: string[] = [];

    for (const m of schema.matchAll(/CREATE TYPE\s+(\w+)\s+AS ENUM\s*\(([\s\S]*?)\);/g)) {
      const [, name, body] = m;
      const declared = [...body.matchAll(/'([^']+)'/g)].map(x => x[1]);
      const ours = (ENUMS as Record<string, readonly string[]>)[name];
      if (!ours) continue;

      if (ours.join(',') !== declared.join(',')) {
        drift.push(`${name}: schema has [${declared.join(', ')}], app has [${ours.join(', ')}]`);
      }
    }

    expect(drift).toEqual([]);
  });
});

describe('local sign-in is development only', () => {
  it('cannot be reached without passing the production guard', () => {
    // Local sign-in mints a session with no password. Every entry point to it
    // must go through assertLocalAuthAllowed(), which refuses a production
    // build unless ALLOW_LOCAL_AUTH=1 is set deliberately.
    const entryPoints = ['app/api/auth/local/route.ts', 'app/signin/page.tsx'];

    for (const file of entryPoints) {
      const body = readFileSync(path.join(ROOT, file), 'utf8');
      expect(body).toMatch(/assertLocalAuthAllowed|localAuthAvailable/);
    }
  });

  it('only /sso and the local sign-in route mint a session', () => {
    // signSession is how a session comes into existence. Anything else calling
    // it is a second way in, and needs the same scrutiny as these two.
    // lib/auth/session.ts is excluded because it DEFINES the function.
    const allowed = new Set([
      'lib/auth/session.ts',
      'app/sso/route.ts',
      'app/api/auth/local/route.ts',
    ]);

    const offenders = sourceFiles()
      .filter(f => /\bsignSession\s*\(/.test(code(f.body)))
      .map(f => f.file)
      .filter(f => !allowed.has(f));

    expect(offenders).toEqual([]);
  });
});

describe('access consistency', () => {
  it('the page shell and the API agree on who has access', () => {
    // These disagreed once: requirePrincipal() refused a user with no roles
    // while the shell only checked for null, so such a user got an empty
    // dashboard and every action failing. Both now call hasAnyAccess().
    const shell = readFileSync(path.join(ROOT, 'app/(app)/layout.tsx'), 'utf8');
    const auth = readFileSync(path.join(ROOT, 'lib/auth/current-user.ts'), 'utf8');

    expect(shell).toMatch(/hasAnyAccess/);
    expect(auth).toMatch(/export function hasAnyAccess/);
    // requirePrincipal must not re-implement the rule inline.
    expect(auth).toMatch(/if \(!hasAnyAccess\(principal\)\)/);
  });
});
