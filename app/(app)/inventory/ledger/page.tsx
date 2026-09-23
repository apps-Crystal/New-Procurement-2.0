import { PageHead } from '@/components/ui';
import { StockLedger } from '@/app/(app)/inventory/ledger/StockLedger';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Inventory" title="Stock ledger" />
      <StockLedger granted={grantedKeys(principal)} />
    </>
  );
}
