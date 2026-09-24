import { PageHead } from '@/components/ui';
import { AuditTrail } from '@/app/(app)/audit/AuditTrail';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <>
      <PageHead crumb="Administration" title="Audit trail" />
      <AuditTrail />
    </>
  );
}
