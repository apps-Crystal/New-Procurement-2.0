/**
 * Shell for every authenticated screen: the prototype's 240px sidebar plus the
 * main column. Middleware has already established a session by the time this
 * renders; what it cannot know is whether the user exists in app_users and has
 * any site role, so that check lives here.
 */
import { redirect } from 'next/navigation';
import { getCurrentPrincipal, hasAnyAccess } from '@/lib/auth/current-user';
import { grantedKeys, openApprovals } from '@/lib/auth/permissions';
import { Sidebar } from '@/components/Sidebar';
import { roleSummary } from '@/lib/labels';
import { isLocalAuth } from '@/lib/auth/mode';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const principal = await getCurrentPrincipal();

  // Same rule the API uses. A user with no role anywhere has nothing to see,
  // and rendering an empty shell for them is worse than saying so.
  if (!hasAnyAccess(principal)) redirect('/no-access');

  return (
    <div className="app">
      <Sidebar
        user={{ fullName: principal.fullName, roleSummary: roleSummary(principal.sites, principal.groupWide) }}
        granted={grantedKeys(principal)}
        localAuth={isLocalAuth()}
      />
      <main id="view">
        {/*
          Loud on purpose. A weakened control that nobody can see is worse than
          no control, and the commonest way this ends badly is somebody forgetting
          it is on and reporting that approvals "work fine".
        */}
        {openApprovals() && (
          <div className="banner warn" role="status">
            <span>
              <b>Segregation of duties is relaxed.</b> OPEN_APPROVALS is set, so any role at a site may take any
              decision there. Approving your own work is still refused — that lives in the database.
            </span>
            <span>Development only. Remove OPEN_APPROVALS from .env.local to put it back.</span>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
