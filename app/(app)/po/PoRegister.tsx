'use client';

/**
 * Purchase order register.
 *
 * Orders are drafted from an awarded quotation on the purchase request, so
 * there is no "new order" button here — an order with no award behind it is
 * exactly what the chain exists to prevent.
 *
 * "Outstanding" is `v_po_line_receipt`, which nets receipts against the order.
 * It is the same figure the receiving queue works from.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtMoney, fmtQty,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';

interface Po {
  id: number;
  po_no: string;
  status: string;
  site_name: string;
  vendor_name: string;
  vendor_code: string;
  pr_no: string;
  buyer_name: string;
  expected_delivery: string;
  total_incl_gst: string | null;
  qty_outstanding: string | null;
  tally_po_ref: string | null;
  created_at: string;
}

const COLS = '150px 1fr 150px 130px 140px 140px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'PO_DRAFT' },
  { label: 'Issued', value: 'PO_CREATED' },
  { label: 'Part received', value: 'PO_PARTIALLY_RECEIVED' },
  { label: 'Received', value: 'PO_RECEIVED' },
];

export function PoRegister() {
  const [status, setStatus] = useState('');
  const url = `/api/po${qs({ status })}`;
  const { data, loading, error, reload } = useResource<Po[]>(url, [status]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      draft: rows.filter(p => p.status === 'PO_DRAFT').length,
      open: rows.filter(p => Number(p.qty_outstanding ?? 0) > 0).length,
      value: rows.reduce((s, p) => s + Number(p.total_incl_gst ?? 0), 0),
    };
  }, [data]);

  return (
    <>
      <Kpis>
        <Kpi label="Orders" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Not yet issued" value={counts.draft} hint="Drafted, awaiting a Tally reference" tone={counts.draft ? 'warn' : undefined} />
        <Kpi label="Awaiting delivery" value={counts.open} hint="Something still outstanding" tone={counts.open ? 'info' : undefined} />
        <Kpi label="Ordered value" value={`₹${fmtMoney(counts.value)}`} hint="Including GST and freight" />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field">
          <span className="lbl">Status</span>
          <div className="seg" role="radiogroup" aria-label="Status">
            {FILTERS.map(f => (
              <button
                key={f.value}
                type="button"
                className="btn btn-sm"
                role="radio"
                aria-checked={status === f.value}
                onClick={() => setStatus(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {loading && <LoadingState rows={6} label="Loading purchase orders" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status ? 'No orders match that' : 'No purchase orders yet'}
          action={
            status ? (
              <button type="button" className="btn" onClick={() => setStatus('')}>Clear filter</button>
            ) : (
              <Link className="btn" href="/pr">Go to purchase requests</Link>
            )
          }
        >
          {status
            ? 'Try a different status.'
            : 'An order is drafted from the awarded quotation on an approved purchase request.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Purchase orders">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Vendor</div>
              <div>Expected</div>
              <div className="r">Outstanding</div>
              <div className="r">Value incl. GST</div>
              <div>Status</div>
            </div>
            {(data ?? []).map(p => (
              <Link key={p.id} href={`/po/${p.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">{p.po_no}</div>
                <div>
                  {p.vendor_name}
                  <div className="sub">
                    {p.site_name} · from <span className="mono">{p.pr_no}</span>
                  </div>
                </div>
                <div>{fmtDate(p.expected_delivery)}</div>
                <div className="r">
                  {Number(p.qty_outstanding ?? 0) > 0 ? fmtQty(p.qty_outstanding) : <span className="sub">none</span>}
                </div>
                <div className="r">₹{fmtMoney(p.total_incl_gst)}</div>
                <div><StatusChip status={p.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
