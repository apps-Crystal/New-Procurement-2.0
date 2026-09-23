import { PageHead } from '@/components/ui';
import { InspectionDetail } from '@/app/(app)/qc/[id]/InspectionDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Receiving / QA/QC" title="Inspection" />
      <InspectionDetail id={Number(id)} granted={grantedKeys(principal)} userId={principal?.userId ?? 0} />
    </>
  );
}
