import { PageHead } from '@/components/ui';
import { PrDetail } from '@/app/(app)/pr/[id]/PrDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function PrDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Procurement / Purchase requests" title="Purchase request" />
      <PrDetail
        id={Number(id)}
        granted={grantedKeys(principal)}
        userId={principal?.userId ?? 0}
        roles={principal?.roles ?? []}
      />
    </>
  );
}
