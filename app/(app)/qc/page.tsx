import { PageHead } from '@/components/ui';
import { QcQueue } from '@/app/(app)/qc/QcQueue';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Receiving" title="QA/QC inspection" />
      <QcQueue granted={grantedKeys(principal)} userId={principal?.userId ?? 0} />
    </>
  );
}
