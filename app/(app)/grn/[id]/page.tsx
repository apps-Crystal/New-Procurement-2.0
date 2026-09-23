import { PageHead } from '@/components/ui';
import { GrnDetail } from '@/app/(app)/grn/[id]/GrnDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Receiving / Goods receipt" title="Goods receipt" />
      <GrnDetail id={Number(id)} granted={grantedKeys(principal)} userId={principal?.userId ?? 0} />
    </>
  );
}
