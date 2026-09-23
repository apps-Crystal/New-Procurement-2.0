import { PageHead } from '@/components/ui';
import { PoDetail } from '@/app/(app)/po/[id]/PoDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function PoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Procurement / Purchase orders" title="Purchase order" />
      <PoDetail id={Number(id)} granted={grantedKeys(principal)} />
    </>
  );
}
