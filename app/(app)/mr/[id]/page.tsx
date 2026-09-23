import { PageHead } from '@/components/ui';
import { MrDetail } from '@/app/(app)/mr/[id]/MrDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function MrDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Procurement / Material requests" title="Material request" />
      <MrDetail id={Number(id)} granted={grantedKeys(principal)} userId={principal?.userId ?? 0} />
    </>
  );
}
