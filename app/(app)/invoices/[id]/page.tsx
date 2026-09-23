import { PageHead } from '@/components/ui';
import { InvoiceDetail } from '@/app/(app)/invoices/[id]/InvoiceDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Accounts / Vendor invoices" title="Invoice" />
      <InvoiceDetail id={Number(id)} granted={grantedKeys(principal)} />
    </>
  );
}
