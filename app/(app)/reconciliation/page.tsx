import { PageHead } from '@/components/ui';
import { ReconRegister } from '@/app/(app)/reconciliation/ReconRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Accounts" title="Vendor reconciliation" />
      <ReconRegister granted={grantedKeys(principal)} />
    </>
  );
}
