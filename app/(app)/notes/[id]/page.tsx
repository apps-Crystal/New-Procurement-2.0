import { PageHead } from '@/components/ui';
import { NoteDetail } from '@/app/(app)/notes/[id]/NoteDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Accounts / Debit & credit notes" title="Debit note" />
      <NoteDetail id={Number(id)} granted={grantedKeys(principal)} />
    </>
  );
}
