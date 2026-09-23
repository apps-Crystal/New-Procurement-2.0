import { PageHead } from '@/components/ui';
import { MrRegister } from '@/app/(app)/mr/MrRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function MrPage() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Procurement" title="Material requests" />
      <MrRegister granted={grantedKeys(principal)} />
    </>
  );
}
