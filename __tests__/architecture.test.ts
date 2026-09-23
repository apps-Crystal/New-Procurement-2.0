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

describe('authorisation (§26, §31)', () => {
  it('permission keys used in navigation all exist in the matrix', async () => {
    const { PERMISSION_MATRIX } = await import('@/lib/auth/permissions');
    const { NAV } = await import('@/lib/nav');

    const unknown = NAV.flatMap(g => g.items)
      .map(i => i.permission)
      .filter(p => !(p in PERMISSION_MATRIX));

    expect(unknown).toEqual([]);
  });

  it('every navigation link resolves to a page, unless marked as not yet built', async () => {
    const { NAV } = await import('@/lib/nav');
    const appDir = path.join(ROOT, 'app', '(app)');

    // A route group folder like (app) does not appear in the URL, and a
    // dynamic segment cannot be reached from a static nav href, so neither
    // needs handling here — every nav href is a literal path.
    const pageExists = (href: string) => {
      const rel = href === '/' ? '' : href.slice(1);
      return statSync(path.join(appDir, rel, 'page.tsx'), { throwIfNoEntry: false }) !== undefined;
    };

    const broken = NAV.flatMap(g => g.items)
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
