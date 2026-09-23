'use client';

/**
 * QA/QC queue, ordered by SLA rather than by arrival.
 *
 * Four hours for cold chain, forty-eight for ambient — so a frozen load that
 * landed an hour ago outranks an ambient one from yesterday, and the list says
 * so rather than making the inspector work it out.
 *
 * The holds tab is the Site Manager's, not the inspector's: a conditional hold
 * is someone else's decision by design, which is why `QC.HOLD_DECIDE` belongs
 * to CG_SMGR alone.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, fmtDateTime, fmtQty,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { HoldDecision } from '@/app/(app)/qc/HoldDecision';

interface Inspection {
  id: number;
  qc_no: string;
  gi_no: string;
  site_name: string;
  po_no: string;
  vendor_name: string;
  inspector_name: string;
  started_at: string;
  completed_at: string | null;
  sla_due_at: string;
  overdue: boolean;
  temp_in_tolerance: boolean | null;
  reinspection_of_no: string | null;
  line_count: string | number;
  qty_hold: string;
}

interface Hold {
  qc_line_id: number;
  qc_id: number;
  qc_no: string;
  gi_no: string;
  site_name: string;
  item_code: string;
  item_name: string;
  uom: string;
  qty_hold: string;
  reason_code: string | null;
  remarks: string | null;
  vendor_name: string;
  po_no: string;
}

const COLS = '140px 1fr 150px 160px 110px';
const HOLD_COLS = '1fr 110px 1fr 140px';

/** Hours left on the SLA, negative once it has passed. */
function hoursLeft(due: string): number {
  return (new Date(due).getTime() - Date.now()) / 3_600_000;
}

export function QcQueue({ granted }: { granted: string[]; userId: number }) {
  const [tab, setTab] = useState<'open' | 'holds' | 'done'>('open');

  const url = tab === 'done' ? '/api/qc?open=0' : tab === 'open' ? '/api/qc?open=1' : null;
  const inspections = useResource<Inspection[]>(url, [tab]);
  const holds = useResource<Hold[]>(tab === 'holds' ? '/api/qc/holds' : null, [tab]);

  const counts = useMemo(() => {
    const rows = inspections.data ?? [];
    return {
      open: rows.length,
      overdue: rows.filter(i => i.overdue).length,
      breached: rows.filter(i => i.temp_in_tolerance === false).length,
    };
  }, [inspections.data]);

  const canDecide = granted.includes('QC.HOLD_DECIDE');

  return (
    <>
      <Kpis>
        <Kpi label={tab === 'done' ? 'Completed' : 'Open inspections'} value={counts.open} hint="Matching the current tab" />
        <Kpi label="Past SLA" value={counts.overdue} hint="4 h cold chain, 48 h ambient" tone={counts.overdue ? 'bad' : 'ok'} />
        <Kpi label="Holds to decide" value={holds.data?.length ?? '—'} hint="The site manager's call" tone={(holds.data?.length ?? 0) > 0 ? 'warn' : undefined} />
        <Kpi label="Cold-chain breach" value={counts.breached} hint="Nothing can be accepted outright" tone={counts.breached ? 'bad' : undefined} />
      </Kpis>

      <section className="card pad" aria-label="View">
        <div className="seg" role="radiogroup" aria-label="View">
          {(
            [
              ['open', 'Open inspections'],
              ['holds', 'Conditional holds'],
              ['done', 'Completed'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="btn btn-sm"
              role="radio"
              aria-checked={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {tab !== 'holds' && (
        <>
          {inspections.loading && <LoadingState rows={5} label="Loading inspections" />}

          {!inspections.loading && inspections.error && (
            <ErrorState
              message={inspections.error}
              retry={<button type="button" className="btn" onClick={inspections.reload}>Try again</button>}
            />
          )}

          {!inspections.loading && !inspections.error && inspections.data?.length === 0 && (
            <EmptyState
              title={tab === 'done' ? 'Nothing completed yet' : 'No inspections are open'}
              action={<Link className="btn" href="/gate-inward">See deliveries awaiting QC</Link>}
            >
              An inspection is opened from a gate inward once it has been handed over. The person who logged
              the delivery in cannot be the one who inspects it.
            </EmptyState>
          )}

          {!inspections.loading && !inspections.error && (inspections.data?.length ?? 0) > 0 && (
            <Card label="Inspections">
              <div className="tbl">
                <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                  <div>Number</div>
                  <div>Vendor and delivery</div>
                  <div>Inspector</div>
                  <div>{tab === 'done' ? 'Completed' : 'SLA'}</div>
                  <div className="r">On hold</div>
                </div>
                {(inspections.data ?? []).map(i => {
                  const left = hoursLeft(i.sla_due_at);
                  return (
                    <Link key={i.id} href={`/qc/${i.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                      <div className="mono">
                        {i.qc_no}
                        {i.reinspection_of_no && <div className="sub">after {i.reinspection_of_no}</div>}
                      </div>
                      <div>
                        {i.vendor_name}
                        <div className="sub">
                          <span className="mono">{i.gi_no}</span> · {i.po_no} · {i.site_name}
                          {i.temp_in_tolerance === false && <strong> · temp breach</strong>}
                        </div>
                      </div>
                      <div className="sub">{i.inspector_name}</div>
                      <div>
                        {i.completed_at ? (
                          <span className="sub">{fmtDateTime(i.completed_at)}</span>
                        ) : i.overdue ? (
                          <span className="chip bad">{Math.abs(Math.round(left))} h over</span>
                        ) : (
                          <span className={left < 2 ? 'chip warn' : 'chip'}>{Math.round(left)} h left</span>
                        )}
                      </div>
                      <div className="r">
                        {Number(i.qty_hold) > 0 ? fmtQty(i.qty_hold) : <span className="sub">—</span>}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}

      {tab === 'holds' && (
        <>
          {holds.loading && <LoadingState rows={4} label="Loading holds" />}

          {!holds.loading && holds.error && (
            <ErrorState
              message={holds.error}
              retry={<button type="button" className="btn" onClick={holds.reload}>Try again</button>}
            />
          )}

          {!holds.loading && !holds.error && holds.data?.length === 0 && (
            <EmptyState title="Nothing is on hold">
              A conditional hold is stock an inspector could neither accept nor reject outright. It waits
              here for a site manager to take it on concession or send it back.
            </EmptyState>
          )}

          {!holds.loading && !holds.error && (holds.data?.length ?? 0) > 0 && (
            <Card label="Conditional holds">
              <div className="tbl">
                <div className="tr th" style={{ gridTemplateColumns: HOLD_COLS }}>
                  <div>Item</div>
                  <div className="r">On hold</div>
                  <div>Why</div>
                  <div>Decision</div>
                </div>
                {(holds.data ?? []).map(h => (
                  <div key={h.qc_line_id} className="tr" style={{ gridTemplateColumns: HOLD_COLS }}>
                    <div>
                      <span className="mono">{h.item_code}</span>
                      <div className="sub">
                        {h.item_name} · <Link href={`/qc/${h.qc_id}`} className="mono">{h.qc_no}</Link> ·{' '}
                        {h.vendor_name}
                      </div>
                    </div>
                    <div className="r">
                      {fmtQty(h.qty_hold)} <span className="sub">{h.uom}</span>
                    </div>
                    <div>
                      <span className="mono">{h.reason_code}</span>
                      {h.remarks && <div className="sub">{h.remarks}</div>}
                    </div>
                    <div>
                      {canDecide ? (
                        <HoldDecision
                          qcLineId={h.qc_line_id}
                          itemCode={h.item_code}
                          qtyHold={h.qty_hold}
                          onDone={holds.reload}
                        />
                      ) : (
                        <span className="sub">A site manager decides this.</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}
