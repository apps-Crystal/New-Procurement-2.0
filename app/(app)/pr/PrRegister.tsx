'use client';

/**
 * Purchase request register.
 *
 * Money shown here is `v_pr_totals`, straight from the view. The register never
 * adds up lines itself: the figure on this list, the figure on the detail and
 * the figure the approval band routes on have to be one number, and the only
 * way to guarantee that is for there to be one source (§10, conflict C-04).
 *
 * `?from_mr=<id>` opens the new-request form against that material request —
 * that is the link the MR screen offers once a request is approved.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtMoney,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { NewPrForm } from '@/app/(app)/pr/NewPrForm';

interface Pr {
  id: number;
  pr_no: string;
  status: string;
  site_code: string;
  site_name: string;
  requester_name: string;
  mr_no: string;
  budget_code: string;
  procurement_type: string;
  expected_delivery: string;
  taxable: string | null;
  gst: string | null;
  total_incl_gst: string | null;
  line_count: string | number;
  created_at: string;
}

const COLS = '150px 1fr 130px 130px 140px 150px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'PR_DRAFT' },
  { label: 'Submitted', value: 'PR_SUBMITTED' },
  { label: 'Approved', value: 'PR_APPROVED' },
  { label: 'Ordered', value: 'PO_POSTED' },
];

export function PrRegister({ granted }: { granted: string[] }) {
  const search = useSearchParams();
  const fromMr = search.get('from_mr');

  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(fromMr !== null);

  const url = `/api/pr${qs({ status, mine: mine ? '1' : '' })}`;
  const { data, loading, error, reload } = useResource<Pr[]>(url, [status, mine]);

  const totals = useMemo(() => {
    const rows = data ?? [];
    return {
      count: rows.length,
      awaiting: rows.filter(p => p.status === 'PR_SUBMITTED').length,
      approved: rows.filter(p => p.status === 'PR_APPROVED').length,
      value: rows.reduce((s, p) => s + Number(p.total_incl_gst ?? 0), 0),
    };
  }, [data]);

  const canCreate = granted.includes('PR.CREATE');
  const filtered = status !== '' || mine;

  return (
    <>
      <Kpis>
        <Kpi label="Requests" value={totals.count} hint="Matching the current filter" />
        <Kpi label="Awaiting approval" value={totals.awaiting} hint="In an approval chain" tone={totals.awaiting ? 'warn' : undefined} />
        <Kpi label="Approved" value={totals.approved} hint="Ready to quote and order" tone="ok" />
        <Kpi label="Value" value={`₹${fmtMoney(totals.value)}`} hint="Including GST, from v_pr_totals" />
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

        <div className="field">
          <label htmlFor="pr-mine" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input id="pr-mine" type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />
            Only the ones I raised
          </label>
        </div>

        {canCreate && !creating && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            Raise a purchase request
          </button>
        )}
      </section>

      {creating && (
        <NewPrForm
          initialMrId={fromMr}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading purchase requests" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={filtered ? 'No requests match that' : 'No purchase requests yet'}
          action={
            filtered ? (
              <button type="button" className="btn" onClick={() => { setStatus(''); setMine(false); }}>
                Clear filters
              </button>
            ) : (
              <Link className="btn" href="/mr">Start from a material request</Link>
            )
          }
        >
          {filtered
            ? 'Try a different stage, or clear the filters.'
            : 'A purchase request carries the balance a material request could not meet from group stock. It cannot be raised on its own.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Purchase requests">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Site and origin</div>
              <div>Budget</div>
              <div>Wanted by</div>
              <div className="r">Value incl. GST</div>
              <div>Stage</div>
            </div>
            {(data ?? []).map(p => (
              <Link key={p.id} href={`/pr/${p.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">{p.pr_no}</div>
                <div>
                  {p.site_name}
                  <div className="sub">
                    from <span className="mono">{p.mr_no}</span> · {p.requester_name}
                  </div>
                </div>
                <div className="sub">{p.budget_code}</div>
                <div>{fmtDate(p.expected_delivery)}</div>
                <div className="r">
                  {p.total_incl_gst === null ? <span className="sub">—</span> : `₹${fmtMoney(p.total_incl_gst)}`}
                </div>
                <div><StatusChip status={p.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
