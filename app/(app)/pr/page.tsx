import { PageHead } from '@/components/ui';
import { PrRegister } from '@/app/(app)/pr/PrRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function PrPage() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Procurement" title="Purchase requests" />
      <PrRegister granted={grantedKeys(principal)} />
    </>
  );
}
