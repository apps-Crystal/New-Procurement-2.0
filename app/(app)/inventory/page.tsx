import { PageHead } from '@/components/ui';
import { StockPosition } from '@/app/(app)/inventory/StockPosition';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Inventory" title="Warehouse stock" />
      <StockPosition granted={grantedKeys(principal)} />
    </>
  );
}
