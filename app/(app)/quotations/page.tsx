import { PageHead } from '@/components/ui';
import { QuotationDesk } from '@/app/(app)/quotations/QuotationDesk';

export const dynamic = 'force-dynamic';

export default function QuotationsPage() {
  return (
    <>
      <PageHead crumb="Procurement" title="Vendor quotations" />
      <QuotationDesk />
    </>
  );
}
