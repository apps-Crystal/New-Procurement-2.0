'use client';

/**
 * Material request register.
 *
 * The status filter doubles as the stage marker: a request moves left to right
 * through stock check, transfer, declaration and approval, and the chips are in
 * that order rather than alphabetical, so the list reads as a pipeline.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtQty,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { NewMrForm } from '@/app/(app)/mr/NewMrForm';

interface Mr {
  id: number;
  mr_no: string;
  site_code: string;
  site_name: string;
  category: string;
  urgency: string;
  required_by: string;
  status: string;
  line_count: string | number;
  qty_to_purchase: string | null;
  qty_to_transfer: string | null;
  requester_name: string | null;
  created_at: string;
}

const COLS = '150px 1fr 130px 110px 120px 90px 170px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'MR_DRAFT' },
  { label: 'Stock checked', value: 'MR_STOCK_PARTIAL' },
  { label: 'Declared', value: 'MR_DECLARED' },
  { label: 'Approved', value: 'MR_APPROVED' },
  { label: 'Converted', value: 'MR_CONVERTED_TO_PR' },
];

const URGENCY_TONE: Record<string, string> = {
  EMERGENCY: 'bad',
  URGENT: 'warn',
};

export function MrRegister({ granted }: { granted: string[] }) {
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);

  const url = `/api/mr${qs({ status, mine: mine ? '1' : '' })}`;
  const { data, loading, error, reload } = useResource<Mr[]>(url, [status, mine]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      awaiting: rows.filter(m => m.status === 'MR_DECLARED').length,
      urgent: rows.filter(m => m.urgency === 'URGENT' || m.urgency === 'EMERGENCY').length,
      approved: rows.filter(m => m.status === 'MR_APPROVED').length,
    };
  }, [data]);

  const canCreate = granted.includes('MR.CREATE');

  return (
    <>
      <Kpis>
        <Kpi label="Requests" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Awaiting approval" value={counts.awaiting} hint="Declared, not yet decided" tone={counts.awaiting ? 'warn' : undefined} />
        <Kpi label="Urgent or emergency" value={counts.urgent} hint="Raised above routine" tone={counts.urgent ? 'bad' : undefined} />
        <Kpi label="Approved" value={counts.approved} hint="Ready to become a PR" tone="ok" />
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
          <label htmlFor="mr-mine" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input id="mr-mine" type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />
            Only the ones I raised
          </label>
        </div>

        {canCreate && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            Raise a request
          </button>
        )}
      </section>

      {creating && (
        <NewMrForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading material requests" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status || mine ? 'No requests match that' : 'No material requests yet'}
          action={
            status || mine ? (
              <button type="button" className="btn" onClick={() => { setStatus(''); setMine(false); }}>
                Clear filters
              </button>
            ) : canCreate ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Raise the first request
              </button>
            ) : null
          }
        >
          {status || mine
            ? 'Try a different stage, or clear the filters to see everything.'
            : 'A material request starts the chain: it says what a site needs, and the stock check decides whether the group already has it.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Material requests">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Site</div>
              <div>Category</div>
              <div>Urgency</div>
              <div>Needed by</div>
              <div className="r">Lines</div>
              <div>Stage</div>
            </div>
            {(data ?? []).map(m => (
              <Link key={m.id} href={`/mr/${m.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">{m.mr_no}</div>
                <div>
                  {m.site_name}
                  {m.requester_name && <div className="sub">{m.requester_name}</div>}
                </div>
                <div className="sub">{m.category.replace(/_/g, ' ').toLowerCase()}</div>
                <div>
                  <span className={`chip ${URGENCY_TONE[m.urgency] ?? ''}`}>{m.urgency.toLowerCase()}</span>
                </div>
                <div>{fmtDate(m.required_by)}</div>
                <div className="r">{fmtQty(m.line_count)}</div>
                <div><StatusChip status={m.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
