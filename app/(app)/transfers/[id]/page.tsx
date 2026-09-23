import { PageHead } from '@/components/ui';
import { TransferDetail } from '@/app/(app)/transfers/[id]/TransferDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Procurement / Stock transfers" title="Stock transfer" />
      <TransferDetail
        id={Number(id)}
        granted={grantedKeys(principal)}
        userId={principal?.userId ?? 0}
        siteIds={(principal?.sites ?? []).map(s => s.siteId)}
      />
    </>
  );
}
