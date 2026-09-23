import { PageHead } from '@/components/ui';
import { NoteRegister } from '@/app/(app)/notes/NoteRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Accounts" title="Debit & credit notes" />
      <NoteRegister granted={grantedKeys(principal)} />
    </>
  );
}
