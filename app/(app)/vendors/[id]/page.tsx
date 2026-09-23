import { PageHead } from '@/components/ui';
import { VendorDetail } from '@/app/(app)/vendors/[id]/VendorDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await getCurrentPrincipal();

  return (
    <>
      <PageHead crumb="Vendors / Detail" title="Vendor" />
      <VendorDetail
        vendorId={Number(id)}
        granted={grantedKeys(principal)}
        currentUserId={principal?.userId ?? 0}
      />
    </>
  );
}
