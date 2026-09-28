/**
 * Local sign-in. DEVELOPMENT ONLY.
 *
 * Pick a user and go. No password — see lib/auth/mode.ts for why that is
 * acceptable on localhost and refused anywhere else.
 *
 * Deliberately ugly-honest rather than polished: it should never be mistaken
 * for a real login screen, and the banner says so.
 */
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { localAuthAvailable, authMode } from '@/lib/auth/mode';
import { SignInPicker } from '@/app/signin/SignInPicker';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  // With Core switched on this page has no reason to exist — the launch token
  // is the only way in.
  if (authMode() === 'core') redirect('/signed-out');

  if (!localAuthAvailable()) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="card pad col" style={{ maxWidth: 520, gap: 12 }}>
          <h1 style={{ fontSize: 20 }}>Local sign-in is disabled</h1>
          <p className="note" style={{ margin: 0 }}>
            This is a production build. Set <code>AUTH_MODE=core</code> to sign in through Crystal Core.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="col" style={{ width: 'min(520px, 100%)', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="brand-mark">
            {/* The same mark as the nav. Here it is on the page surface rather
                than the dark nav, so it takes its colour from --mark-filter. */}
            <Image src="/crystal-mark.png" alt="" width={256} height={162} priority aria-hidden="true" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Crystal</div>
            <div className="sub">Assets &amp; Procurement</div>
          </div>
        </div>

        <div className="banner warn">
          <span>
            <b>Development sign-in.</b> There is no password — pick a user and you are them. Crystal Core SSO replaces
            this before anyone outside your machine can reach it.
          </span>
        </div>

        <SignInPicker />
      </div>
    </main>
  );
}
