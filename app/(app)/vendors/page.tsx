import { PageHead } from '@/components/ui';
import { VendorRegister } from '@/app/(app)/vendors/VendorRegister';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function VendorsPage() {
  const principal = await getCurrentPrincipal();
  const granted = grantedKeys(principal);

  return (
    <>
      <PageHead crumb="Vendors" title="Vendor master" />
      <VendorRegister granted={granted} />
    </>
  );
}
