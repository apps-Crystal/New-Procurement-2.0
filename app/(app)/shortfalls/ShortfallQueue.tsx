'use client';

/**
 * Shortfall cases.
 *
 * Nobody raises these. They appear when a delivery is handed to QC and the
 * count came up short of the challan, and the quantity is a generated column —
 * so a case can never claim a shortfall the count does not support.
 *
 * The decision is only about the order, never about stock: nothing arrived, so
 * there is nothing to post. AWAIT_BALANCE keeps the gap showing as outstanding;
 * SHORT_CLOSE accepts it will never come.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip,
  fmtDate, fmtQty,
} from '@/components/ui';
import { api, qs } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface ShortfallCase {
  id: number;
  sht_no: string;
  decision: string;
  qty_short: string;
  gi_no: string;
  challan_no: string;
  arrived_at: string;
  site_name: string;
  po_no: string;
  po_id: number;
  vendor_name: string;
  item_code: string;
  item_name: string;
  uom: string;
  qty_per_challan: string;
  qty_counted: string;
  decided_by_name: string | null;
  created_at: string;
}

const COLS = '140px 1fr 150px 110px 1fr';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Awaiting balance', value: 'AWAIT_BALANCE' },
  { label: 'Short-closed', value: 'SHORT_CLOSE' },
];

export function ShortfallQueue({ granted }: { granted: string[]; userId: number }) {
  const [decision, setDecision] = useState('PENDING');
  const [deciding, setDeciding] = useState<number | null>(null);
  const [remarks, setRemarks] = useState('');

  const url = `/api/shortfalls${qs({ decision })}`;
  const { data, loading, error, reload } = useResource<ShortfallCase[]>(url, [decision]);

  const decide = useMutation(
    async (args: { id: number; decision: 'AWAIT_BALANCE' | 'SHORT_CLOSE' }) =>
      api.post(`/api/shortfalls/${args.id}`, { decision: args.decision, remarks: remarks || null }),
    { onDone: () => { setDeciding(null); setRemarks(''); reload(); } },
  );

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      qty: rows.reduce((s, r) => s + Number(r.qty_short), 0),
      pending: rows.filter(r => r.decision === 'PENDING').length,
    };
  }, [data]);

  const canDecide = granted.includes('SHORTFALL.DECIDE');

  return (
    <>
      <Kpis>
        <Kpi label="Cases" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Undecided" value={counts.pending} hint="Waiting on a buyer or site manager" tone={counts.pending ? 'warn' : 'ok'} />
        <Kpi label="Quantity short" value={fmtQty(counts.qty)} hint="Across the cases listed" />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field">
          <span className="lbl">Decision</span>
          <div className="seg" role="radiogroup" aria-label="Decision">
            {FILTERS.map(f => (
              <button
                key={f.value}
                type="button"
                className="btn btn-sm"
                role="radio"
                aria-checked={decision === f.value}
                onClick={() => setDecision(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {decide.error && <Banner kind="bad">{decide.error}</Banner>}

      {loading && <LoadingState rows={5} label="Loading shortfall cases" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={decision === 'PENDING' ? 'Nothing is waiting to be decided' : 'No cases match that'}
          action={<button type="button" className="btn" onClick={() => setDecision('')}>Show every case</button>}
        >
          A case is raised on its own when a delivery is counted short against its challan. There is nothing
          to create here.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Shortfall cases">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Case</div>
              <div>Item and delivery</div>
              <div className="r">Challan / counted</div>
              <div className="r">Short</div>
              <div>Decision</div>
            </div>
            {(data ?? []).map(c => (
              <div key={c.id} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">
                  {c.sht_no}
                  <div className="sub">{fmtDate(c.created_at)}</div>
                </div>
                <div>
                  <span className="mono">{c.item_code}</span>
                  <div className="sub">
                    {c.item_name} · {c.vendor_name} ·{' '}
                    <Link href={`/po/${c.po_id}`} className="mono">{c.po_no}</Link> · {c.gi_no}
                  </div>
                </div>
                <div className="r sub">
                  {fmtQty(c.qty_per_challan)} / {fmtQty(c.qty_counted)}
                </div>
                <div className="r">
                  <strong>{fmtQty(c.qty_short)}</strong> <span className="sub">{c.uom}</span>
                </div>
                <div>
                  {c.decision !== 'PENDING' ? (
                    <>
                      <StatusChip status={c.decision} />
                      {c.decided_by_name && <div className="sub">by {c.decided_by_name}</div>}
                    </>
                  ) : !canDecide ? (
                    <span className="sub">A buyer or site manager decides this.</span>
                  ) : deciding === c.id ? (
                    <div>
                      <div className="field" style={{ margin: '0 0 6px' }}>
                        <label htmlFor={`sf-why-${c.id}`} className="sr-only">Remarks for {c.sht_no}</label>
                        <input
                          id={`sf-why-${c.id}`}
                          className="inp"
                          value={remarks}
                          onChange={e => setRemarks(e.target.value)}
                          maxLength={500}
                          placeholder="Required to short-close"
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={decide.busy}
                          onClick={() => void decide.run({ id: c.id, decision: 'AWAIT_BALANCE' })}
                        >
                          Await balance
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={decide.busy || remarks.trim().length < 1}
                          onClick={() => void decide.run({ id: c.id, decision: 'SHORT_CLOSE' })}
                        >
                          Short-close
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setDeciding(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-sm" onClick={() => { setDeciding(c.id); setRemarks(''); }}>
                      Decide
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
