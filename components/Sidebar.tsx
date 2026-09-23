'use client';

/**
 * Sidebar — the prototype's 240px dark nav, with two additions:
 * links are filtered by the caller's permissions, and the footer shows the real
 * Crystal Core identity and site rather than static text.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 2v20M4.9 6.5l14.2 11M19.1 6.5L4.9 17.5" />
            </svg>
          </div>
          <div>
            <b>Crystal</b>
            <small>Assets &amp; Procurement</small>
          </div>
        </div>

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

function ThemeToggle() {
  return (
    <button
      type="button"
      className="theme-btn"
      onClick={() => {
        const root = document.documentElement;
        const dark =
          root.getAttribute('data-theme') === 'dark' ||
          (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
        const next = dark ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try {
          localStorage.setItem('theme', next);
        } catch {
          /* private mode — the choice simply doesn't persist */
        }
      }}
    >
      Switch light / dark
    </button>
  );
}
