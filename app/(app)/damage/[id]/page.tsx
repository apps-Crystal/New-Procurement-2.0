import { PageHead } from '@/components/ui';
import { DamageDetail } from '@/app/(app)/damage/[id]/DamageDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Inventory / Damaged & missing" title="Damage report" />
      <DamageDetail
        id={Number(id)}
        granted={grantedKeys(principal)}
        userId={principal?.userId ?? 0}
        roles={principal?.roles ?? []}
      />
    </>
  );
}
