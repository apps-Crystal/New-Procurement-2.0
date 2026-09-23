import { PageHead } from '@/components/ui';
import { MastersHub } from '@/app/(app)/masters/MastersHub';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function MastersPage() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Administration" title="Master data" />
      <MastersHub granted={grantedKeys(principal)} />
    </>
  );
}
