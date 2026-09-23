import { PageHead } from '@/components/ui';
import { ReturnRegister } from '@/app/(app)/returns/ReturnRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Receiving" title="Purchase returns" />
      <ReturnRegister granted={grantedKeys(principal)} />
    </>
  );
}
