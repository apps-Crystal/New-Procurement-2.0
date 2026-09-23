import { PageHead } from '@/components/ui';
import { AssetRegister } from '@/app/(app)/inventory/assets/AssetRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Inventory" title="Asset register" />
      <AssetRegister granted={grantedKeys(principal)} />
    </>
  );
}
