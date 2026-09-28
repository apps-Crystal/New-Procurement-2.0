'use client';

/**
 * Sidebar — the prototype's 240px dark nav, with two additions:
 * links are filtered by the caller's permissions, and the footer shows the real
 * Crystal Core identity and site rather than static text.
 */
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NAV, activeHref } from '@/lib/nav';

export interface SidebarUser {
  fullName: string;
  /** e.g. "Site Receiver · Dhulagarh" */
  roleSummary: string;
}

export function Sidebar({
  user,
  granted,
  localAuth,
}: {
  user: SidebarUser;
  granted: string[];
  /** Local development sign-in rather than Crystal Core. */
  localAuth: boolean;
}) {
  const pathname = usePathname();
  const active = activeHref(pathname);
  const [open, setOpen] = useState(false);
  const held = new Set(granted);

  const groups = NAV.map(g => ({ ...g, items: g.items.filter(i => held.has(i.permission)) })).filter(
    g => g.items.length > 0,
  );

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
              {g.items.map(i =>
                i.comingIn ? (
                  // Not a link: the screen does not exist yet, and a 404 reads as
                  // something broken rather than as something not built.
                  <span key={i.href} className="nav-link is-pending" aria-disabled="true">
                    {i.label}
                    <em>{i.comingIn}</em>
                  </span>
                ) : (
                  <Link
                    key={i.href}
                    href={i.href}
                    className="nav-link"
                    aria-current={i.href === active ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                  >
                    {i.label}
                  </Link>
                ),
              )}
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
