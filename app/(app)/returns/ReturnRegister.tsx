'use client';

/**
 * Purchase returns.
 *
 * A return has exactly one origin, and which one decides whether stock moves at
 * all when it is approved:
 *
 *   QC rejection      failed inspection, never received — nothing to reverse
 *   Warehouse damage  received and later damaged — comes out of damaged hold
 *   Shortfall         never arrived — nothing to reverse
 *
 * The register shows the origin on every row rather than only the vendor,
 * because "why is this going back" is the first thing anyone asks, and because
 * the two that post nothing look identical to the one that does otherwise.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtMoney, fmtQty,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { NewReturnForm } from '@/app/(app)/returns/NewReturnForm';

interface Rtv {
  id: number;
  rtv_no: string;
  status: string;
  source: string;
  basis: string;
  site_name: string;
  vendor_name: string;
  po_no: string;
  prn_no: string | null;
  gate_pass_no: string | null;
  vendor_rma_no: string | null;
  raised_by_name: string;
  line_count: string | number;
  total_qty: string;
  value: string;
  created_at: string;
}

const COLS = '150px 1fr 160px 130px 130px 150px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'RTV_DRAFT' },
  { label: 'Approved', value: 'RTV_APPROVED' },
  { label: 'Dispatched', value: 'RTV_DISPATCHED' },
  { label: 'Acknowledged', value: 'RTV_ACKNOWLEDGED' },
];

export const SOURCE_LABEL: Record<string, string> = {
  QC_REJECTION: 'QC rejection',
  WAREHOUSE_DAMAGE: 'Warehouse damage',
  SHORTFALL: 'Shortfall',
};

export function ReturnRegister({ granted }: { granted: string[] }) {
  const [status, setStatus] = useState('');
  const [raising, setRaising] = useState(false);

  const url = `/api/rtv${qs({ status })}`;
  const { data, loading, error, reload } = useResource<Rtv[]>(url, [status]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      toApprove: rows.filter(r => r.status === 'RTV_DRAFT').length,
      inTransit: rows.filter(r => r.status === 'RTV_DISPATCHED').length,
      value: rows.filter(r => r.status !== 'RTV_CANCELLED').reduce((s, r) => s + Number(r.value ?? 0), 0),
    };
  }, [data]);

  const canRaise = granted.includes('RTV.CREATE');

  return (
    <>
      <Kpis>
        <Kpi label="Returns" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Awaiting approval" value={counts.toApprove} hint="No documents minted yet" tone={counts.toApprove ? 'warn' : undefined} />
        <Kpi label="With the vendor" value={counts.inTransit} hint="Dispatched, not yet acknowledged" tone={counts.inTransit ? 'info' : undefined} />
        <Kpi label="Value returned" value={`₹${fmtMoney(counts.value)}`} hint="Including GST" />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field">
          <span className="lbl">Stage</span>
          <div className="seg" role="radiogroup" aria-label="Stage">
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

        {canRaise && !raising && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setRaising(true)}>
            Raise a return
          </button>
        )}
      </section>

      {raising && (
        <NewReturnForm
          onClose={() => setRaising(false)}
          onCreated={() => {
            setRaising(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading returns" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status ? 'Nothing matches that' : 'Nothing has been returned'}
          action={
            status ? (
              <button type="button" className="btn" onClick={() => setStatus('')}>Clear filter</button>
            ) : canRaise ? (
              <button type="button" className="btn btn-primary" onClick={() => setRaising(true)}>Raise a return</button>
            ) : null
          }
        >
          A return starts from something that already went wrong — an inspection that rejected goods,
          damage cleared for return, or a shortfall the vendor still owes. It cannot be raised on its own.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Purchase returns">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Vendor and origin</div>
              <div>Documents</div>
              <div className="r">Quantity</div>
              <div className="r">Value</div>
              <div>Stage</div>
            </div>
            {(data ?? []).map(r => (
              <Link key={r.id} href={`/returns/${r.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">
                  {r.rtv_no}
                  <div className="sub">{fmtDate(r.created_at)}</div>
                </div>
                <div>
                  {r.vendor_name}
                  <div className="sub">
                    {SOURCE_LABEL[r.source] ?? r.source} · {r.basis.replace(/_/g, ' ').toLowerCase()} ·{' '}
                    <span className="mono">{r.po_no}</span>
                  </div>
                </div>
                <div className="sub">
                  {r.prn_no ? (
                    <>
                      <span className="mono">{r.prn_no}</span>
                      <div className="mono">{r.gate_pass_no}</div>
                    </>
                  ) : (
                    'minted on approval'
                  )}
                  {r.vendor_rma_no && <div>RMA {r.vendor_rma_no}</div>}
                </div>
                <div className="r">{fmtQty(r.total_qty)}</div>
                <div className="r">₹{fmtMoney(r.value)}</div>
                <div><StatusChip status={r.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
