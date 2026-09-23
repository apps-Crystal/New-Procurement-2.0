/**
 * The user exists but has no site role.
 *
 * Separate from /signin because the fix is different: an administrator has to
 * grant a role, not sign in again. Every record in Procurement belongs to a
 * site, so a user with no grant genuinely has nothing to see.
 */
import { getSession } from '@/lib/auth/current-user';
import { isLocalAuth } from '@/lib/auth/mode';

export const dynamic = 'force-dynamic';

export default async function NoAccess() {
  const session = await getSession();
  const local = isLocalAuth();

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card pad col" style={{ maxWidth: 560, gap: 14 }}>
        <h1 style={{ fontSize: 20 }}>No access yet</h1>

        <p className="note" style={{ margin: 0 }}>
          {session?.email ? `${session.email} is signed in` : 'You are signed in'}, but has no role at any site.
          Every record in Procurement belongs to a site, so there is nothing to show until a role is granted.
        </p>

        {local && (
          <div className="box">
            <span className="sub">Grant yourself administrator</span>
            <code className="mono" style={{ fontSize: 12 }}>
              npm run bootstrap:admin -- {session?.email ?? 'you@crystalgroup.in'}
            </code>
            <span className="sub">Add --site DHU --name Dhulagarh --state 19 --gstin … --tally … if there are no sites yet.</span>
          </div>
        )}

        <div className="seg">
          <a className="btn" href="/logout">{local ? 'Pick a different user' : 'Sign out'}</a>
        </div>
      </div>
    </main>
  );
}
