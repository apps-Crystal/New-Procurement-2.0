import { PageHead } from '@/components/ui';
import { ShortfallQueue } from '@/app/(app)/shortfalls/ShortfallQueue';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Receiving" title="Shortfalls" />
      <ShortfallQueue granted={grantedKeys(principal)} userId={principal?.userId ?? 0} />
    </>
  );
}
