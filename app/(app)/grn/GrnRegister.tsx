'use client';

/**
 * Goods receipt register.
 *
 * Approval is the moment material becomes stock, so the register is really a
 * queue of things waiting for that moment. `?from_qc=<id>` drafts a receipt
 * straight from a completed inspection — the link the QC screen offers.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Banner, Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip,
  fmtDate, fmtMoney, fmtQty,
} from '@/components/ui';
import { api, qs } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Grn {
  id: number;
  grn_no: string;
  status: string;
  site_name: string;
  po_no: string;
  vendor_name: string;
  gi_no: string | null;
  qc_no: string | null;
  approved_by_name: string | null;
  line_count: string | number;
  qty_accepted: string;
  qty_concession: string;
  value: string;
  flag_reason: string | null;
  created_at: string;
}

const COLS = '150px 1fr 140px 120px 140px 140px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'GRN_DRAFT' },
  { label: 'Flagged', value: 'GRN_FLAGGED' },
  { label: 'Approved', value: 'GRN_APPROVED' },
  { label: 'Closed', value: 'GRN_CLOSED' },
];

export function GrnRegister({ granted }: { granted: string[]; userId: number }) {
  const search = useSearchParams();
  const fromQc = search.get('from_qc');

  const [status, setStatus] = useState('');
  const url = `/api/grn${qs({ status })}`;
  const { data, loading, error, reload } = useResource<Grn[]>(url, [status]);

  const draft = useMutation(
    async (qcId: string) => api.post('/api/grn', { qc_id: Number(qcId) }),
    { onDone: reload, successMessage: 'Receipt drafted.' },
  );

  // Arriving with ?from_qc drafts the receipt once, then the register takes over.
  const [drafted, setDrafted] = useState(false);
  useEffect(() => {
    if (fromQc && !drafted) {
      setDrafted(true);
      void draft.run(fromQc);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromQc, drafted]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      awaiting: rows.filter(g => g.status === 'GRN_DRAFT').length,
      flagged: rows.filter(g => g.status === 'GRN_FLAGGED').length,
      value: rows.filter(g => g.status !== 'GRN_REJECTED').reduce((s, g) => s + Number(g.value ?? 0), 0),
    };
  }, [data]);

  const canCreate = granted.includes('GRN.CREATE');

  return (
    <>
      <Kpis>
        <Kpi label="Receipts" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Awaiting approval" value={counts.awaiting} hint="No stock posted yet" tone={counts.awaiting ? 'warn' : undefined} />
        <Kpi label="Flagged" value={counts.flagged} hint="Something has to be settled first" tone={counts.flagged ? 'bad' : undefined} />
        <Kpi label="Received value" value={`₹${fmtMoney(counts.value)}`} hint="At order rates" />
      </Kpis>

      {draft.error && <Banner kind="bad">{draft.error}</Banner>}
      {draft.success && fromQc && <Banner kind="ok">{draft.success}</Banner>}

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

      {loading && <LoadingState rows={6} label="Loading goods receipts" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status ? 'No receipts match that' : 'No goods receipts yet'}
          action={
            status ? (
              <button type="button" className="btn" onClick={() => setStatus('')}>Clear filter</button>
            ) : (
              <Link className="btn" href="/qc">Go to inspections</Link>
            )
          }
        >
          {status
            ? 'Try a different status.'
            : canCreate
              ? 'A receipt is drafted from a completed inspection, and posts stock only when it is approved.'
              : 'Receipts appear here once a delivery has been inspected.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Goods receipts">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Vendor and origin</div>
              <div>Raised</div>
              <div className="r">Accepted</div>
              <div className="r">Value</div>
              <div>Status</div>
            </div>
            {(data ?? []).map(g => (
              <Link key={g.id} href={`/grn/${g.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">{g.grn_no}</div>
                <div>
                  {g.vendor_name}
                  <div className="sub">
                    <span className="mono">{g.po_no}</span>
                    {g.gi_no && <> · {g.gi_no}</>}
                    {g.qc_no && <> · {g.qc_no}</>} · {g.site_name}
                  </div>
                  {g.flag_reason && <div className="sub"><strong>Flagged:</strong> {g.flag_reason}</div>}
                </div>
                <div className="sub">
                  {fmtDate(g.created_at)}
                  {g.approved_by_name && <div>by {g.approved_by_name}</div>}
                </div>
                <div className="r">
                  {fmtQty(g.qty_accepted)}
                  {Number(g.qty_concession) > 0 && (
                    <div className="sub">incl. {fmtQty(g.qty_concession)} concession</div>
                  )}
                </div>
                <div className="r">₹{fmtMoney(g.value)}</div>
                <div><StatusChip status={g.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
