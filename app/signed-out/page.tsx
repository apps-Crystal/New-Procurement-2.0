/**
 * Shown when Crystal Core could not establish a session.
 *
 * Only reachable with AUTH_MODE=core. Deliberately plain and public — it must
 * render without a session and without a database.
 */
import { isLocalAuth } from '@/lib/auth/mode';
import { redirect } from 'next/navigation';

const REASONS: Record<string, string> = {
  missing_token: 'The sign-in link did not carry a launch token. Open Procurement from Crystal Core.',
  sso_failed: 'Crystal Core could not verify that sign-in. Try again from Core.',
  sso_incomplete_identity: 'Crystal Core did not return a complete identity. Contact your administrator.',
  sso_unreachable: 'Crystal Core could not be reached. Try again in a moment.',
  legacy_login_disabled: 'That sign-in link is no longer supported. Open Procurement from Crystal Core.',
};

export const dynamic = 'force-dynamic';

export default async function SignedOut({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // With Core switched off there is nothing to send anyone back to.
  if (isLocalAuth()) redirect('/signin');

  const { error } = await searchParams;
  const message = (error && REASONS[error]) || 'You are signed out of Procurement.';
  const coreUrl = process.env.CRYSTAL_CORE_URL || 'https://crystal-core-official-version.vercel.app';

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card pad col" style={{ maxWidth: 460, gap: 14, textAlign: 'center' }}>
        <h1 style={{ fontSize: 20, justifyContent: 'center' }}>Crystal · Assets &amp; Procurement</h1>
        <p className="note" style={{ margin: 0 }}>{message}</p>
        <a className="btn btn-primary" href={coreUrl}>Go to Crystal Core</a>
      </div>
    </main>
  );
}
