import { PageHead } from '@/components/ui';
import { ApprovalQueue } from '@/app/(app)/approvals/ApprovalQueue';

export const dynamic = 'force-dynamic';

export default function ApprovalsPage() {
  return (
    <>
      <PageHead crumb="Overview" title="Pending approvals" />
      <ApprovalQueue />
    </>
  );
}
