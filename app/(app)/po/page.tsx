import { PageHead } from '@/components/ui';
import { PoRegister } from '@/app/(app)/po/PoRegister';

export const dynamic = 'force-dynamic';

export default function PoPage() {
  return (
    <>
      <PageHead crumb="Procurement" title="Purchase orders" />
      <PoRegister />
    </>
  );
}
