/**
 * Dashboard. Placeholder until Phase 9 — every tile will be a real query.
 * No fake numbers ship here in the meantime (brief §24, §35).
 */
import { PageHead, Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default function Dashboard() {
  return (
    <>
      <PageHead crumb="Overview" title="Dashboard" />
      <Card pad label="Dashboard status">
        <p className="note" style={{ margin: 0 }}>
          The dashboard is built in Phase 9, once the modules it reports on exist. Every tile will come from a database
          query — nothing here will be a static number.
        </p>
      </Card>
    </>
  );
}
