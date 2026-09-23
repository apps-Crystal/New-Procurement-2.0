'use client';

/**
 * Gate inward register.
 *
 * Nothing on this screen is stock. A gate inward is a record of what arrived at
 * the gate and was counted by hand; it becomes inventory only when a goods
 * receipt is approved, several steps later. The counts shown are therefore what
 * was counted, including any excess over the challan — never clamped (C-09).
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDateTime, fmtQty,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { NewGateInwardForm } from '@/app/(app)/gate-inward/NewGateInwardForm';

interface Gi {
  id: number;
  gi_no: string;
  status: string;
  site_name: string;
  po_no: string;
  vendor_name: string;
  vehicle_no: string;
  challan_no: string;
  arrived_at: string;
  received_by_name: string;
  temp_in_tolerance: boolean | null;
  qc_no: string | null;
  line_count: string | number;
  qty_counted: string;
  qty_short: string;
}

const COLS = '150px 1fr 140px 130px 110px 150px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'At the gate', value: 'INWARD_RECEIVED' },
  { label: 'Awaiting QC', value: 'QC_PENDING' },
  { label: 'Being inspected', value: 'QC_IN_PROGRESS' },
  { label: 'Inspected', value: 'QC_COMPLETED' },
];

export function GateInwardRegister({ granted }: { granted: string[]; userId: number }) {
  const [status, setStatus] = useState('');
  const [logging, setLogging] = useState(false);

  const url = `/api/gate-inward${qs({ status })}`;
  const { data, loading, error, reload } = useResource<Gi[]>(url, [status]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      awaitingQc: rows.filter(g => g.status === 'QC_PENDING').length,
      short: rows.filter(g => Number(g.qty_short) > 0).length,
      breached: rows.filter(g => g.temp_in_tolerance === false).length,
    };
  }, [data]);

  const canLog = granted.includes('GATE_INWARD.CREATE');

  return (
    <>
      <Kpis>
        <Kpi label="Deliveries" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Awaiting inspection" value={counts.awaitingQc} hint="Handed over to QC" tone={counts.awaitingQc ? 'warn' : undefined} />
        <Kpi label="Short against challan" value={counts.short} hint="Each raised a shortfall case" tone={counts.short ? 'warn' : undefined} />
        <Kpi label="Cold-chain breach" value={counts.breached} hint="Ran outside the band" tone={counts.breached ? 'bad' : undefined} />
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

        {canLog && !logging && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setLogging(true)}>
            Log a delivery
          </button>
        )}
      </section>

      {logging && (
        <NewGateInwardForm
          onClose={() => setLogging(false)}
          onCreated={() => {
            setLogging(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading deliveries" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status ? 'No deliveries match that' : 'Nothing has arrived yet'}
          action={
            status ? (
              <button type="button" className="btn" onClick={() => setStatus('')}>Clear filter</button>
            ) : canLog ? (
              <button type="button" className="btn btn-primary" onClick={() => setLogging(true)}>Log the first delivery</button>
            ) : (
              <Link className="btn" href="/po">See expected deliveries</Link>
            )
          }
        >
          {status
            ? 'Try a different stage.'
            : 'A delivery is logged against an issued purchase order, counted by hand, then handed to QC.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Gate inwards">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Vendor and order</div>
              <div>Vehicle</div>
              <div>Arrived</div>
              <div className="r">Counted</div>
              <div>Stage</div>
            </div>
            {(data ?? []).map(g => (
              <Link key={g.id} href={`/gate-inward/${g.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">{g.gi_no}</div>
                <div>
                  {g.vendor_name}
                  <div className="sub">
                    <span className="mono">{g.po_no}</span> · challan {g.challan_no} · {g.site_name}
                  </div>
                </div>
                <div>
                  <span className="mono">{g.vehicle_no}</span>
                  {g.temp_in_tolerance === false && <div className="sub"><strong>Temp breach</strong></div>}
                  {g.temp_in_tolerance === true && <div className="sub">Temp in band</div>}
                </div>
                <div className="sub">
                  {fmtDateTime(g.arrived_at)}
                  <div>{g.received_by_name}</div>
                </div>
                <div className="r">
                  {fmtQty(g.qty_counted)}
                  {Number(g.qty_short) > 0 && <div className="sub">short {fmtQty(g.qty_short)}</div>}
                </div>
                <div><StatusChip status={g.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
