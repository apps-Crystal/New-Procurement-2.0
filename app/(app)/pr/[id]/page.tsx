import Link from 'next/link';
import { PageHead } from '@/components/ui';
import { PrDetail } from '@/app/(app)/pr/[id]/PrDetail';
import { getCurrentPrincipal } from '@/lib/auth/current-user';
import { grantedKeys, openAccess } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function PrDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const principal = await getCurrentPrincipal();

  // Reached from the quotation desk rather than the purchase request register.
  const viaQuotations = from === 'quotations';

  return (
    <>
      <PageHead
        crumb={viaQuotations ? 'Procurement / Vendor quotations' : 'Procurement / Purchase requests'}
        title="Purchase request"
        actions={
          viaQuotations ? (
            <Link className="btn" href="/quotations">
              Back to the quotation desk
            </Link>
          ) : undefined
        }
      />
      <PrDetail
        id={Number(id)}
        granted={grantedKeys(principal)}
        userId={principal?.userId ?? 0}
        roles={principal?.roles ?? []}
        devOpen={openAccess()}
      />
    </>
  );
}
