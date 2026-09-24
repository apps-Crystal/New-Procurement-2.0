/**
 * Phase 10 hardening checks (brief §25, §32, §33).
 *
 * Three things that are cheap to check statically and expensive to find by
 * hand: error messages that leak the database, form controls with no label,
 * and interactive elements a keyboard cannot reach.
 *
 * JSX cannot be matched with a naive regex — an arrow function inside an
 * attribute contains `>`, so `[^>]*` stops in the middle of the tag. The
 * `openingTag` helper below scans properly, tracking brace depth and strings,
 * which is the difference between a test that works and one that reports the
 * first handler it meets.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');

function walk(dir: string, match: RegExp): { file: string; body: string }[] {
  const out: { file: string; body: string }[] = [];
  const full = path.join(ROOT, dir);
  if (statSync(full, { throwIfNoEntry: false }) === undefined) return out;

  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (match.test(entry.name)) {
        out.push({ file: path.relative(ROOT, p).replace(/\\/g, '/'), body: readFileSync(p, 'utf8') });
      }
    }
  };

  visit(full);
  return out;
}

/**
 * The opening tag starting at `from`, up to its own closing `>`.
 *
 * Skips over `>` inside `{…}` expressions and inside strings, which is what a
 * regex cannot do — `onClick={() => x}` would otherwise end the tag at the
 * arrow.
 */
function openingTag(body: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;

  for (let i = from; i < body.length; i++) {
    const c = body[i];

    if (quote) {
      if (c === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (c === '>' && depth === 0) return body.slice(from, i + 1);
  }

  return body.slice(from);
}

/** Every opening tag of the given element names, with its position. */
function tagsOf(body: string, names: string[]): { name: string; tag: string }[] {
  const out: { name: string; tag: string }[] = [];
  const re = new RegExp(`<(${names.join('|')})\\b`, 'g');

  for (const m of body.matchAll(re)) {
    out.push({ name: m[1], tag: openingTag(body, m.index) });
  }

  return out;
}

const SERVICES = walk('lib/services', /\.ts$/);
const SCREENS = walk('app', /\.tsx$/);
const COMPONENTS = walk('components', /\.tsx$/);
const ALL_UI = [...SCREENS, ...COMPONENTS];

// =============================================================================
// Error messages (§32)
// =============================================================================

describe('error messages (§32)', () => {
  const LEAKS: { pattern: RegExp; what: string }[] = [
    { pattern: /SQLSTATE|sqlstate/, what: 'a SQLSTATE code' },
    { pattern: /\bpg_\w+/, what: 'a PostgreSQL internal name' },
    { pattern: /duplicate key value violates/, what: 'a raw PostgreSQL error' },
    { pattern: /violates (check|foreign key|not-null) constraint/, what: 'a raw constraint violation' },
    { pattern: /\bstack\b.*\btrace\b/i, what: 'a stack trace' },
  ];

  it('no thrown message leaks database internals', () => {
    const offenders: string[] = [];

    for (const { file, body } of SERVICES) {
      const thrown = [
        ...body.matchAll(/throw (?:badRequest|conflict|forbidden|notFound|new AppError)\(([\s\S]{0,400}?)\);/g),
      ].map(m => m[1]);

      for (const message of thrown) {
        for (const leak of LEAKS) {
          if (leak.pattern.test(message)) {
            offenders.push(`${file}: ${leak.what} in "${message.slice(0, 80)}…"`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every mapped constraint has a sentence, not a name', async () => {
    const { CONSTRAINT_MESSAGES } = await import('@/lib/errors');

    const entries = Object.entries(CONSTRAINT_MESSAGES);
    expect(entries.length).toBeGreaterThan(40);

    // A message that just repeats the constraint name helps nobody read it.
    const bad = entries
      .filter(([, v]) => {
        const message = (v as { message: string }).message;
        return /^[a-z_]+$/.test(message) || message.length < 15;
      })
      .map(([key]) => key);

    expect(bad).toEqual([]);
  });

  it('messages read as sentences', () => {
    const offenders: string[] = [];

    for (const { file, body } of SERVICES) {
      const thrown = [
        ...body.matchAll(/throw (?:badRequest|conflict|forbidden|notFound)\(\s*'([^']{20,})'/g),
      ].map(m => m[1]);

      for (const message of thrown) {
        if (!/[.?!]$/.test(message.trim())) {
          offenders.push(`${file}: "${message.slice(0, 70)}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// Accessibility (§25)
// =============================================================================

describe('accessibility (§25)', () => {
  it('every form control with a fixed id has a label', () => {
    const offenders: string[] = [];

    for (const { file, body } of ALL_UI) {
      for (const { name, tag } of tagsOf(body, ['input', 'select', 'textarea'])) {
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        if (!id) continue; // dynamic ids are covered by the next test

        const hasLabel = body.includes(`htmlFor="${id}"`);
        const hasAria = /\baria-label=/.test(tag) || /\baria-labelledby=/.test(tag);

        if (!hasLabel && !hasAria) {
          offenders.push(`${file}: <${name} id="${id}"> has no label`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('form controls with a per-row id are labelled too', () => {
    const offenders: string[] = [];

    for (const { file, body } of ALL_UI) {
      for (const { name, tag } of tagsOf(body, ['input', 'select', 'textarea'])) {
        const prefix = /\bid=\{`([a-z0-9-]+)-\$\{/i.exec(tag)?.[1];
        if (!prefix) continue;

        const hasLabel = new RegExp(`htmlFor=\\{\`${prefix}-\\$\\{`).test(body);
        const hasAria = /\baria-label=/.test(tag);

        if (!hasLabel && !hasAria) {
          offenders.push(`${file}: <${name} id={\`${prefix}-…\`}> has no label`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('clickable non-buttons are reachable by keyboard', () => {
    const offenders: string[] = [];

    for (const { file, body } of ALL_UI) {
      for (const { name, tag } of tagsOf(body, ['div', 'span', 'li', 'tr'])) {
        if (!/\bonClick=/.test(tag)) continue;

        // Without all three, a keyboard user simply cannot operate it.
        const reachable =
          /\brole=/.test(tag) && /\btabIndex=/.test(tag) && /\bonKeyDown=/.test(tag);

        if (!reachable) {
          offenders.push(`${file}: <${name} onClick> missing role, tabIndex or onKeyDown`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('icon-only buttons carry an accessible name', () => {
    const offenders: string[] = [];

    for (const { file, body } of ALL_UI) {
      // A button whose visible content is a symbol rather than words.
      for (const m of body.matchAll(/<button\b/g)) {
        const tag = openingTag(body, m.index);
        const after = body.slice(m.index + tag.length, m.index + tag.length + 60);
        const content = /^\s*([^<]*)</.exec(after)?.[1]?.trim() ?? '';

        const symbolic = content !== '' && /^[×✓✗+\-–—…·]+$/.test(content);
        if (symbolic && !/\baria-label=/.test(tag)) {
          offenders.push(`${file}: <button>${content}</button> has no aria-label`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every screen sets a heading through PageHead', () => {
    const pages = SCREENS.filter(f => /app\/\(app\)\/.*page\.tsx$/.test(f.file));
    expect(pages.length).toBeGreaterThan(10);

    const missing = pages.filter(p => !p.body.includes('PageHead')).map(p => p.file);
    expect(missing).toEqual([]);
  });

  it('filter groups are announced as radio groups', () => {
    const offenders: string[] = [];

    for (const { file, body } of SCREENS) {
      // The status-filter pattern: a .seg of buttons acting as one choice.
      for (const m of body.matchAll(/className="seg"/g)) {
        const tag = openingTag(body, body.lastIndexOf('<', m.index));
        if (!/\brole="radiogroup"/.test(tag)) continue;
        if (!/\baria-label=/.test(tag)) {
          offenders.push(`${file}: a radiogroup with no aria-label`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
