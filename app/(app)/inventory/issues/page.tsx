import { PageHead } from '@/components/ui';
import { IssueRegister } from '@/app/(app)/inventory/issues/IssueRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Inventory" title="Stock issues" />
      <IssueRegister granted={grantedKeys(principal)} />
    </>
  );
}
