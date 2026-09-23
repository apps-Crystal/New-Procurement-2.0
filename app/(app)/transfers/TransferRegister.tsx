'use client';

/**
 * Stock transfer register.
 *
 * Transfers are raised from a material request rather than here, so this screen
 * has no "new" button: it is the queue a Warehouse Lead works through. The
 * direction filter is relative to the sites the viewer holds — "out" is stock
 * leaving one of them, "in" is stock arriving.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtQty,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';

interface Transfer {
  id: number;
  transfer_no: string;
  status: string;
  from_code: string;
  from_name: string;
  to_code: string;
  to_name: string;
  mr_no: string | null;
  requested_by_name: string | null;
  line_count: string | number;
  created_at: string;
}

const COLS = '160px 1fr 1fr 140px 90px 160px';

const STATUSES = [
  { label: 'All', value: '' },
  { label: 'Requested', value: 'TRF_REQUESTED' },
  { label: 'Approved', value: 'TRF_APPROVED' },
  { label: 'Dispatched', value: 'TRF_DISPATCHED' },
  { label: 'Received', value: 'TRF_RECEIVED' },
];

const DIRECTIONS = [
  { label: 'All', value: '' },
  { label: 'Leaving my sites', value: 'out' },
  { label: 'Arriving at my sites', value: 'in' },
];

export function TransferRegister() {
  const [status, setStatus] = useState('');
  const [direction, setDirection] = useState('');

  const url = `/api/transfers${qs({ status, direction })}`;
  const { data, loading, error, reload } = useResource<Transfer[]>(url, [status, direction]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      toDecide: rows.filter(t => t.status === 'TRF_REQUESTED').length,
      toDispatch: rows.filter(t => t.status === 'TRF_APPROVED').length,
      inTransit: rows.filter(t => t.status === 'TRF_DISPATCHED').length,
    };
  }, [data]);

  const filtered = status !== '' || direction !== '';

  return (
    <>
      <Kpis>
        <Kpi label="Transfers" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Awaiting a decision" value={counts.toDecide} hint="The holding site decides" tone={counts.toDecide ? 'warn' : undefined} />
        <Kpi label="Ready to dispatch" value={counts.toDispatch} hint="Stock is reserved" tone={counts.toDispatch ? 'info' : undefined} />
        <Kpi label="In transit" value={counts.inTransit} hint="Dispatched, not yet received" tone={counts.inTransit ? 'info' : undefined} />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field">
          <span className="lbl">Status</span>
          <div className="seg" role="radiogroup" aria-label="Status">
            {STATUSES.map(f => (
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
          <span className="lbl">Direction</span>
          <div className="seg" role="radiogroup" aria-label="Direction">
            {DIRECTIONS.map(f => (
              <button
                key={f.value}
                type="button"
                className="btn btn-sm"
                role="radio"
                aria-checked={direction === f.value}
                onClick={() => setDirection(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {loading && <LoadingState rows={6} label="Loading transfers" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={filtered ? 'No transfers match that' : 'No stock transfers yet'}
          action={
            filtered ? (
              <button type="button" className="btn" onClick={() => { setStatus(''); setDirection(''); }}>
                Clear filters
              </button>
            ) : (
              <Link className="btn" href="/mr">Go to material requests</Link>
            )
          }
        >
          {filtered
            ? 'Try a different status or direction.'
            : 'Transfers start from a material request: run its stock check, decide how much to take from another site, then request the move.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Stock transfers">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>From</div>
              <div>To</div>
              <div>Against</div>
              <div className="r">Lines</div>
              <div>Status</div>
            </div>
            {(data ?? []).map(t => (
              <Link key={t.id} href={`/transfers/${t.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">{t.transfer_no}</div>
                <div>
                  {t.from_name}
                  <div className="sub">{t.from_code}</div>
                </div>
                <div>
                  {t.to_name}
                  <div className="sub">{t.to_code}</div>
                </div>
                <div className="sub">
                  {t.mr_no ? <span className="mono">{t.mr_no}</span> : '—'}
                  <div>{fmtDate(t.created_at)}</div>
                </div>
                <div className="r">{fmtQty(t.line_count)}</div>
                <div><StatusChip status={t.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
