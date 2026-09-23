import { PageHead } from '@/components/ui';
import { InvoiceRegister } from '@/app/(app)/invoices/InvoiceRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Accounts" title="Vendor invoices" />
      <InvoiceRegister granted={grantedKeys(principal)} />
    </>
  );
}
