import { PageHead } from '@/components/ui';
import { GateInwardRegister } from '@/app/(app)/gate-inward/GateInwardRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Receiving" title="Gate inward" />
      <GateInwardRegister granted={grantedKeys(principal)} userId={principal?.userId ?? 0} />
    </>
  );
}
