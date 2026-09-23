import { PageHead } from '@/components/ui';
import { GrnRegister } from '@/app/(app)/grn/GrnRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Receiving" title="Goods receipt (GRN)" />
      <GrnRegister granted={grantedKeys(principal)} userId={principal?.userId ?? 0} />
    </>
  );
}
