'use client';

/**
 * The quotation desk.
 *
 * Quotations belong to a purchase request — a quote with no request behind it
 * has nothing to be compared against — so they are captured on the request's
 * own screen. This is the queue that leads there: approved requests that still
 * need quotes, comparison or an award.
 *
 * Once an order exists the request leaves the desk, because the one-PO-per-PR
 * rule (conflict C-17) means there is nothing further to quote.
 */
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, fmtDate, fmtMoney,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';

interface Pr {
  id: number;
  pr_no: string;
  status: string;
  site_name: string;
  requester_name: string;
  procurement_type: string;
  expected_delivery: string;
  total_incl_gst: string | null;
  line_count: string | number;
}

const COLS = '150px 1fr 140px 140px 140px';

/** Days until the request is wanted; negative means it is already late. */
function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function QuotationDesk() {
  const { data, loading, error, reload } = useResource<Pr[]>('/api/pr?status=PR_APPROVED');

  const rows = data ?? [];
  const value = rows.reduce((s, p) => s + Number(p.total_incl_gst ?? 0), 0);
  const late = rows.filter(p => daysUntil(p.expected_delivery) < 0).length;

  return (
    <>
      <Kpis>
        <Kpi label="Awaiting quotation" value={rows.length} hint="Approved, not yet ordered" tone={rows.length ? 'info' : 'ok'} />
        <Kpi label="Estimated value" value={`₹${fmtMoney(value)}`} hint="From v_pr_totals" />
        <Kpi label="Past the wanted date" value={late} hint="Needs chasing" tone={late ? 'bad' : undefined} />
      </Kpis>

      {loading && <LoadingState rows={5} label="Loading the quotation desk" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && rows.length === 0 && (
        <EmptyState
          title="Nothing is waiting for quotations"
          action={<Link className="btn" href="/pr">See all purchase requests</Link>}
        >
          Approved purchase requests appear here until an order is raised against them. Open one to record
          what each vendor quoted and compare them.
        </EmptyState>
      )}

      {!loading && !error && rows.length > 0 && (
        <Card label="Awaiting quotation">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Request</div>
              <div>Site and requester</div>
              <div>Wanted by</div>
              <div className="r">Estimated value</div>
              <div>Next step</div>
            </div>
            {rows.map(p => {
              const days = daysUntil(p.expected_delivery);
              return (
                <Link key={p.id} href={`/pr/${p.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                  <div className="mono">{p.pr_no}</div>
                  <div>
                    {p.site_name}
                    <div className="sub">
                      {p.requester_name} · {p.procurement_type.toLowerCase()}
                    </div>
                  </div>
                  <div>
                    {fmtDate(p.expected_delivery)}
                    <div className="sub">
                      {days < 0 ? <strong>{-days} days late</strong> : `in ${days} days`}
                    </div>
                  </div>
                  <div className="r">
                    {p.total_incl_gst === null ? <span className="sub">—</span> : `₹${fmtMoney(p.total_incl_gst)}`}
                  </div>
                  <div className="sub">Record quotations</div>
                </Link>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}
