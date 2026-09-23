import { PageHead } from '@/components/ui';
import { ReconDetail } from '@/app/(app)/reconciliation/[id]/ReconDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Accounts / Reconciliation" title="Reconciliation run" />
      <ReconDetail id={Number(id)} granted={grantedKeys(principal)} />
    </>
  );
}
