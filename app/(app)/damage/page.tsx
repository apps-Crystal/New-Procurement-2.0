import { PageHead } from '@/components/ui';
import { DamageRegister } from '@/app/(app)/damage/DamageRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Inventory" title="Damaged & missing" />
      <DamageRegister granted={grantedKeys(principal)} userId={principal?.userId ?? 0} />
    </>
  );
}
