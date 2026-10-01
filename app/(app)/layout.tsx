/**
 * Shell for every authenticated screen: the prototype's 240px sidebar plus the
 * main column. Middleware has already established a session by the time this
 * renders; what it cannot know is whether the user exists in app_users and has
 * any site role, so that check lives here.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentPrincipal, hasAnyAccess } from '@/lib/auth/current-user';
import { grantedKeys, openAccess, openApprovals } from '@/lib/auth/permissions';
import { Sidebar } from '@/components/Sidebar';
import { OpenApprovalsNotice } from '@/components/OpenApprovalsNotice';
import { NAV_COLLAPSED_COOKIE, parseCollapsed } from '@/lib/nav';
import { roleSummary } from '@/lib/labels';
import { isLocalAuth } from '@/lib/auth/mode';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const principal = await getCurrentPrincipal();

  // Same rule the API uses. A user with no role anywhere has nothing to see,
  // and rendering an empty shell for them is worse than saying so.
  if (!hasAnyAccess(principal)) redirect('/no-access');

  // Read here, not in the Sidebar: the sidebar is rendered server-side, so a
  // collapsed section has to be collapsed in the first HTML. Anything the
  // client decides after hydration arrives a paint too late and flickers.
  const collapsed = parseCollapsed((await cookies()).get(NAV_COLLAPSED_COOKIE)?.value);

  return (
    <div className="app">
      <Sidebar
        user={{ fullName: principal.fullName, roleSummary: roleSummary(principal.sites, principal.groupWide) }}
        granted={grantedKeys(principal)}
        localAuth={isLocalAuth()}
        collapsed={collapsed}
      />
      <main id="view">
        {/* Visible, but one line and dismissible — see the component. */}
        {openApprovals() && <OpenApprovalsNotice level={openAccess() ? 'access' : 'approvals'} />}
        {children}
      </main>
    </div>
  );
}
