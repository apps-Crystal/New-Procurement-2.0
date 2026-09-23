'use client';

/**
 * Pending approvals.
 *
 * Everything listed here is something the viewer can actually decide: the
 * server has already dropped levels that are not yet reachable, records at
 * sites they do not hold, and anything they raised themselves. So an empty
 * queue means there is nothing to do, not that the filter is wrong.
 */
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, fmtDateTime, fmtMoney,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';

interface Pending {
  entityType: string;
  entityId: number;
  levelNo: number;
  requiredRole: string;
  createdAt: string;
  reference: string;
  originator: string;
  siteName: string;
  value: string | null;
  href: string;
}

const COLS = '170px 1fr 150px 90px 150px';

const WHAT: Record<string, string> = {
  PR: 'Purchase request',
  NON_LOWEST_AWARD: 'Non-lowest award',
  QUOTE_WAIVER: 'Quotation waiver',
  WRITE_OFF: 'Write-off',
};

/** Days waiting, for the ageing hint. */
function waitingDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

export function ApprovalQueue() {
  const { data, loading, error, reload } = useResource<Pending[]>('/api/approvals');

  const rows = data ?? [];
  const value = rows.reduce((s, r) => s + Number(r.value ?? 0), 0);
  const stale = rows.filter(r => waitingDays(r.createdAt) >= 3).length;

  return (
    <>
      <Kpis>
        <Kpi label="Waiting for you" value={rows.length} hint="Only what you can decide now" tone={rows.length ? 'warn' : 'ok'} />
        <Kpi label="Value held up" value={`₹${fmtMoney(value)}`} hint="Total of the items below" />
        <Kpi label="Waiting 3 days or more" value={stale} hint="Ageing in the queue" tone={stale ? 'bad' : undefined} />
      </Kpis>

      {loading && <LoadingState rows={5} label="Loading your approvals" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && rows.length === 0 && (
        <EmptyState title="Nothing is waiting for you">
          When something reaches a level your role decides, it appears here. Requests you raised yourself
          never do — someone else has to approve those.
        </EmptyState>
      )}

      {!loading && !error && rows.length > 0 && (
        <Card label="Pending approvals">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Reference</div>
              <div>What, and whose</div>
              <div>Waiting since</div>
              <div className="r">Level</div>
              <div className="r">Value</div>
            </div>
            {rows.map(r => {
              const days = waitingDays(r.createdAt);
              return (
                <Link
                  key={`${r.entityType}-${r.entityId}-${r.levelNo}`}
                  href={r.href}
                  className="tr"
                  style={{ gridTemplateColumns: COLS }}
                >
                  <div className="mono">{r.reference}</div>
                  <div>
                    {WHAT[r.entityType] ?? r.entityType}
                    <div className="sub">
                      {r.originator} · {r.siteName}
                    </div>
                  </div>
                  <div>
                    {fmtDateTime(r.createdAt)}
                    {days >= 3 && <div className="sub"><strong>{days} days</strong></div>}
                  </div>
                  <div className="r">
                    <span className="chip">L{r.levelNo}</span>
                  </div>
                  <div className="r">
                    {r.value === null ? <span className="sub">—</span> : `₹${fmtMoney(r.value)}`}
                  </div>
                </Link>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}
