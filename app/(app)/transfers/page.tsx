import { PageHead } from '@/components/ui';
import { TransferRegister } from '@/app/(app)/transfers/TransferRegister';

export const dynamic = 'force-dynamic';

export default function TransfersPage() {
  return (
    <>
      <PageHead crumb="Procurement" title="Stock transfers" />
      <TransferRegister />
    </>
  );
}
