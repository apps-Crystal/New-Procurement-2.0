'use client';

/**
 * Vendor reconciliation.
 *
 * Two ledgers written independently: PORTAL by this application, TALLY imported
 * from the accounts system. Neither is adjusted to agree with the other, which
 * is what makes the comparison worth anything.
 *
 * `recon_zero_to_close` refuses to close a run while the two differ — not
 * "warns", refuses. So the difference column is the only one that decides
 * anything, and it is shown as money rather than as a status word.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtMoney,
} from '@/components/ui';
import { api, qs } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Run {
  id: number;
  vendor_id: number;
  vendor_name: string;
  vendor_code: string;
  period_start: string;
  period_end: string;
  portal_balance: string;
  tally_balance: string;
  difference: string;
  held_amount: string;
  status: string;
  reconciled_by_name: string | null;
  unmatched: string | number;
  unresolved: string | number;
}

interface Vendor {
  id: number;
  legal_name: string;
  vendor_code: string;
}

const COLS = '1fr 170px 140px 140px 140px 160px';

export function ReconRegister({ granted }: { granted: string[] }) {
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');

  const url = `/api/reconciliation${qs({ status })}`;
  const { data, loading, error, reload } = useResource<Run[]>(url, [status]);
  const vendors = useResource<Vendor[]>('/api/vendors?status=VENDOR_APPROVED');

  const run = useMutation(
    async () =>
      api.post('/api/reconciliation', {
        vendor_id: Number(vendorId),
        period_start: periodStart,
        period_end: periodEnd,
      }),
    { onDone: () => { setRunning(false); reload(); }, successMessage: 'Reconciliation taken.' },
  );

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      out: rows.filter(r => Math.abs(Number(r.difference)) >= 0.01).length,
      unresolved: rows.reduce((s, r) => s + Number(r.unresolved ?? 0), 0),
      gap: rows.reduce((s, r) => s + Math.abs(Number(r.difference ?? 0)), 0),
    };
  }, [data]);

  const canRun = granted.includes('RECON.RUN');

  return (
    <>
      <Kpis>
        <Kpi label="Runs" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Out of balance" value={counts.out} hint="Cannot be closed until they agree" tone={counts.out ? 'bad' : 'ok'} />
        <Kpi label="Unresolved items" value={counts.unresolved} hint="Sitting on one side only" tone={counts.unresolved ? 'warn' : undefined} />
        <Kpi label="Total gap" value={`₹${fmtMoney(counts.gap)}`} hint="Across every open run" />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field">
          <span className="lbl">Status</span>
          <div className="seg" role="radiogroup" aria-label="Status">
            {[
              { label: 'All', value: '' },
              { label: 'Open', value: 'RECON_OPEN' },
              { label: 'Difference', value: 'RECON_DIFFERENCE' },
              { label: 'Reconciled', value: 'RECON_RECONCILED' },
              { label: 'Confirmed', value: 'RECON_CONFIRMED_BY_VENDOR' },
            ].map(f => (
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

        {canRun && !running && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setRunning(true)}>
            Take a reconciliation
          </button>
        )}
      </section>

      {running && (
        <Card title="Take a reconciliation" label="Take a reconciliation" right={<button type="button" className="btn btn-sm" onClick={() => setRunning(false)}>Cancel</button>}>
          <form
            className="pad"
            onSubmit={e => {
              e.preventDefault();
              void run.run(undefined);
            }}
          >
            {run.error && <Banner kind="bad">{run.error}</Banner>}

            <div className="grid g3">
              <div className="field">
                <label htmlFor="rc-vendor">Vendor</label>
                <select id="rc-vendor" className="inp" value={vendorId} onChange={e => setVendorId(e.target.value)} required>
                  <option value="">Choose a vendor…</option>
                  {(vendors.data ?? []).map(v => (
                    <option key={v.id} value={v.id}>{v.legal_name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rc-from">Period from</label>
                <input id="rc-from" className="inp" type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="rc-to">Period to</label>
                <input id="rc-to" className="inp" type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} required />
              </div>
            </div>

            <p className="sub">
              Balances are taken as at the period end and stored on the run. Import the Tally side first, or
              every row will show as sitting only in the portal.
            </p>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" className="btn btn-primary" disabled={run.busy || !vendorId || !periodStart || !periodEnd}>
                {run.busy ? 'Running…' : 'Take it'}
              </button>
              <button type="button" className="btn" onClick={() => setRunning(false)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}

      {loading && <LoadingState rows={5} label="Loading reconciliations" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status ? 'Nothing matches that' : 'No reconciliations yet'}
          action={
            canRun ? (
              <button type="button" className="btn btn-primary" onClick={() => setRunning(true)}>Take one</button>
            ) : null
          }
        >
          A run compares what this system believes a vendor is owed against what the accounts system
          believes. Neither side is adjusted to agree with the other.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Reconciliation runs">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Vendor</div>
              <div>Period</div>
              <div className="r">Portal</div>
              <div className="r">Tally</div>
              <div className="r">Difference</div>
              <div>Status</div>
            </div>
            {(data ?? []).map(r => {
              const out = Math.abs(Number(r.difference)) >= 0.01;
              return (
                <Link key={r.id} href={`/reconciliation/${r.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                  <div>
                    {r.vendor_name}
                    <div className="sub">
                      {Number(r.unmatched)} unmatched
                      {Number(r.unresolved) > 0 && `, ${r.unresolved} unresolved`}
                    </div>
                  </div>
                  <div className="sub">
                    {fmtDate(r.period_start)}
                    <div>to {fmtDate(r.period_end)}</div>
                  </div>
                  <div className="r">₹{fmtMoney(r.portal_balance)}</div>
                  <div className="r">₹{fmtMoney(r.tally_balance)}</div>
                  <div className="r">
                    {out ? (
                      <span className="chip bad">₹{fmtMoney(r.difference)}</span>
                    ) : (
                      <span className="chip ok">agreed</span>
                    )}
                  </div>
                  <div>
                    <StatusChip status={r.status} />
                    {r.reconciled_by_name && <div className="sub">{r.reconciled_by_name}</div>}
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
