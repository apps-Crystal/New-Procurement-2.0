import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Crystal · Assets & Procurement',
  description: 'Crystal Group procurement and asset management',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/**
 * Applies the saved theme before first paint so a dark-mode user never sees a
 * light flash. Runs ahead of hydration by design.
 *
 * Only 'light' and 'dark' are honoured. "Auto" is stored as the ABSENCE of the
 * key, which leaves data-theme off and hands the decision to the
 * `prefers-color-scheme` block in globals.css -- so the theme keeps following
 * the device instead of freezing at whatever it was when the user last chose.
 * Anything else in the key is stale or hand-edited; it is cleared rather than
 * trusted, because an unknown value would otherwise pin the theme to nothing
 * with no way back through the UI.
 */
const THEME_SCRIPT = `try{var d=document.documentElement,t=localStorage.getItem('theme');if(t==='light'||t==='dark'){d.setAttribute('data-theme',t)}else{d.removeAttribute('data-theme');if(t!==null)localStorage.removeItem('theme')}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // THEME_SCRIPT sets data-theme on this element before React hydrates, so
    // the server HTML and the live DOM deliberately differ here. Without this,
    // React reports a hydration mismatch on every load where a theme is stored.
    // It suppresses one level only -- the children are still fully checked.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
