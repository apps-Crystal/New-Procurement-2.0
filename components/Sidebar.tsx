'use client';

/**
 * Sidebar — the prototype's 240px dark nav, with two additions:
 * links are filtered by the caller's permissions, and the footer shows the real
 * Crystal Core identity and site rather than static text.
 */
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useState } from 'react';
import { NAV, NAV_COLLAPSED_COOKIE, activeHref } from '@/lib/nav';
import type { NavItem, NavIconName } from '@/lib/nav';

/**
 * Small marks for the shortcut links.
 *
 * Decorative: every one sits beside its own text label, so they are
 * aria-hidden. An icon that repeats the word next to it should not be read out
 * twice, and an icon alone would mean nothing to a screen reader.
 */
function NavIcon({ name }: { name?: NavIconName }) {
  if (!name) return null;

  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'nav-sub-icon',
  };

  switch (name) {
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 2.8 20 6v6c0 4.6-3.3 8.1-8 9.2-4.7-1.1-8-4.6-8-9.2V6Z" />
        </svg>
      );
    case 'person':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.4" />
          <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" />
        </svg>
      );
  }
}

/** The disclosure on a parent that has shortcuts under it. */
function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export interface SidebarUser {
  fullName: string;
  /** e.g. "Site Receiver · Dhulagarh" */
  roleSummary: string;
}

export function Sidebar({
  user,
  granted,
  localAuth,
  collapsed: initialCollapsed,
}: {
  user: SidebarUser;
  granted: string[];
  /** Local development sign-in rather than Crystal Core. */
  localAuth: boolean;
  /** Parent hrefs whose shortcuts are hidden, read from the cookie server-side. */
  collapsed: string[];
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const active = activeHref(pathname);

  /**
   * A child is current when its path matches AND every parameter it names is
   * set. `/mr?stage=MR_DECLARED` must not light up on plain `/mr`, and two
   * children of the same screen must not both light up.
   */
  const childIsCurrent = (href: string) => {
    const [path, query] = href.split('?');
    if (pathname !== path) return false;
    return [...new URLSearchParams(query ?? '')].every(([k, v]) => search.get(k) === v);
  };
  const [open, setOpen] = useState(false);

  /**
   * Seeded from the server's value, so the first client render matches the
   * HTML exactly and nothing moves. Writing the cookie rather than calling the
   * server keeps the toggle instant -- the next navigation renders it right.
   */
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  const toggle = (href: string) => {
    const next = collapsed.includes(href) ? collapsed.filter(h => h !== href) : [...collapsed, href];
    setCollapsed(next);
    try {
      document.cookie = `${NAV_COLLAPSED_COOKIE}=${encodeURIComponent(next.join('|'))}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* cookies blocked -- the choice still holds for this page */
    }
  };

  const held = new Set(granted);

  const visible = (i: NavItem): NavItem => ({
    ...i,
    children: i.children?.filter(c => held.has(c.permission)),
  });

  const groups = NAV.map(g => ({
    ...g,
    items: g.items.filter(i => held.has(i.permission)).map(visible),
  })).filter(g => g.items.length > 0);

  return (
    <>
      <div className="topbar">
        <button type="button" aria-label="Open navigation" aria-controls="nav" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <b>Crystal · Assets &amp; Procurement</b>
      </div>

      <nav id="nav" className={`side${open ? ' open' : ''}`} aria-label="Main navigation">
        <div className="brand">
          <div className="brand-mark">
            {/*
              The Crystal mark, cut from the supplied logo with its white paper
              turned transparent. It is black artwork; the stylesheet paints it
              white, so one file serves both themes and there is no rectangle
              around it on the dark nav.
            */}
            <Image
              src="/crystal-mark.png"
              alt=""
              width={256}
              height={162}
              priority
              aria-hidden="true"
            />
          </div>
          <div>
            <b>Crystal</b>
            <small>Assets &amp; Procurement</small>
          </div>
        </div>

        {/*
          Only the links scroll. The brand above and the identity and theme
          controls below stay put -- with twenty-odd links the footer used to
          sit below the fold, so nobody ever found what was down there.
        */}
        <div className="nav-scroll">
          {groups.map(g => (
            <div className="nav-group" key={g.label}>
              <div className="nav-label">{g.label}</div>
              {/*
                Each item is followed immediately by its own shortcuts. They
                were rendered in a second pass, which put every child at the
                bottom of the group — so "Raise a request" sat under Purchase
                orders rather than under the screen it belongs to.

                The shortcuts sit in a panel the parent's disclosure controls,
                so a user who does not want them can fold them away.
              */}
              {g.items.map(i => {
                const kids = i.children ?? [];
                // The parent steps back when a shortcut below it is the exact
                // match -- two elements claiming aria-current="page" is both
                // heavy to look at and wrong for a screen reader.
                const current = i.href === active && !kids.some(c => childIsCurrent(c.href));
                const shut = collapsed.includes(i.href);
                const panelId = `nav-kids-${i.href.replace(/[^a-z0-9]+/gi, '-')}`;

                return (
                  <Fragment key={i.href}>
                    {i.comingIn ? (
                      // Not a link: the screen does not exist yet, and a 404 reads
                      // as something broken rather than as something not built.
                      <span className="nav-link is-pending" aria-disabled="true">
                        {i.label}
                        <em>{i.comingIn}</em>
                      </span>
                    ) : (
                      <div className={kids.length > 0 ? 'nav-item' : undefined}>
                        <Link
                          href={i.href}
                          className="nav-link"
                          aria-current={current ? 'page' : undefined}
                          // Clicking the row does BOTH: it goes to the screen,
                          // and it folds the shortcuts under it. The chevron
                          // alone was too small a target to be the only way.
                          // Nothing is prevented here, so the link still
                          // navigates -- this only adds the fold.
                          onClick={() => {
                            setOpen(false);
                            if (kids.length > 0) toggle(i.href);
                          }}
                        >
                          {i.label}
                        </Link>

                        {kids.length > 0 && (
                          // Still its own button, for two reasons: it shows
                          // which way the section is folded, and it carries the
                          // aria-expanded/aria-controls pair that tells a screen
                          // reader what the row is doing. A click here folds
                          // without navigating, which is the quieter action.
                          <button
                            type="button"
                            className={`nav-toggle${current ? ' on-current' : ''}`}
                            aria-expanded={!shut}
                            aria-controls={panelId}
                            aria-label={`${shut ? 'Show' : 'Hide'} ${i.label} shortcuts`}
                            onClick={() => toggle(i.href)}
                          >
                            <Chevron />
                          </button>
                        )}
                      </div>
                    )}

                    {kids.length > 0 && (
                      <div className="nav-children" id={panelId} hidden={shut}>
                        {kids.map(c => (
                          <Link
                            key={c.href}
                            href={c.href}
                            className="nav-link nav-sub"
                            aria-current={childIsCurrent(c.href) ? 'page' : undefined}
                            onClick={() => setOpen(false)}
                          >
                            <NavIcon name={c.icon} />
                            {c.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          ))}
        </div>

        <div className="nav-foot">
          <b>{user.fullName}</b>
          {user.roleSummary}
          <br />
          {localAuth ? (
            <a href="/logout" style={{ color: 'var(--nav-muted)' }}>
              Switch user
            </a>
          ) : (
            'Signed in via Crystal Core'
          )}
          <ThemeToggle />
        </div>
      </nav>
    </>
  );
}

type ThemeMode = 'light' | 'dark' | 'system';

const THEME_MODES: { value: ThemeMode; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    value: 'light',
    label: 'Light',
    hint: 'Always use the light theme',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.2v2.1M12 19.7v2.1M4.4 4.4l1.5 1.5M18.1 18.1l1.5 1.5M2.2 12h2.1M19.7 12h2.1M4.4 19.6l1.5-1.5M18.1 5.9l1.5-1.5" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    hint: 'Always use the dark theme',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z" />
      </svg>
    ),
  },
  {
    value: 'system',
    label: 'Auto',
    hint: 'Follow the device setting, and change with it',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2.6" y="4" width="18.8" height="12.6" rx="2" />
        <path d="M8.5 20.8h7M12 16.6v4.2" />
      </svg>
    ),
  },
];

/**
 * Light / Dark / Auto.
 *
 * "Auto" is not decoration: without it, one click pins the theme forever and
 * there is no way back to the device setting. It is stored by REMOVING the key,
 * so the CSS `prefers-color-scheme` block takes over again and the theme keeps
 * following the device as it changes through the day.
 *
 * The matching no-flash script lives in app/layout.tsx and reads the same key.
 */
function ThemeToggle() {
  // The server cannot know the choice -- it lives in localStorage -- so the
  // control renders unset and adopts the real value once mounted. Guessing on
  // the server means a hydration mismatch and a visibly wrong segment first.
  const [mode, setMode] = useState<ThemeMode | null>(null);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('theme');
    } catch {
      /* private mode — nothing was stored, so the device setting stands */
    }
    setMode(saved === 'light' || saved === 'dark' ? saved : 'system');
  }, []);

  function choose(next: ThemeMode) {
    setMode(next);

    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);

    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch {
      /* private mode — the choice holds for this tab and does not outlive it */
    }
  }

  return (
    <div className="theme-seg" role="radiogroup" aria-label="Colour theme">
      {THEME_MODES.map(m => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={mode === m.value}
          title={m.hint}
          onClick={() => choose(m.value)}
        >
          {m.icon}
          {m.label}
        </button>
      ))}
    </div>
  );
}
