'use client';

/**
 * Gate inward detail.
 *
 * The two numbers that matter are side by side: what the challan claimed, and
 * what was counted. Everything downstream follows from the second one — QC
 * inspects the counted quantity (C-10), a shortfall case is raised from the
 * difference, and an excess is carried forward to be stopped at goods receipt
 * (C-09) rather than quietly absorbed here.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDateTime, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { Documents } from '@/components/Documents';

interface Row { [k: string]: unknown }

interface GiView {
  gi: Row & {
    id: number; gi_no: string; status: string; site_name: string; po_id: number; po_no: string;
    vendor_name: string; vehicle_no: string; challan_no: string; challan_date: string;
    transporter: string | null; driver_name: string | null; lr_no: string | null; seal_no: string | null;
    arrived_at: string; received_by: number; received_by_name: string;
    reefer_set_point_c: string | null; reefer_actual_c: string | null;
    temp_in_tolerance: boolean | null; rejection_reason: string | null;
    qc_id: number | null; qc_no: string | null;
  };
  lines: (Row & {
    id: number; item_code: string; item_name: string; uom: string;
    qty_per_challan: string; qty_counted: string; qty_short: string; qty_excess: string;
    item_class_code: string; is_cold_chain: boolean;
  })[];
  band: {
    required: boolean; minC: number | null; maxC: number | null;
    requiresDataLogger: boolean; classes: string[];
  };
}

const COLS = '1fr 120px 120px 120px 80px';

export function GateInwardDetail({ id, granted, userId }: { id: number; granted: string[]; userId: number }) {
  const { data, loading, error, reload } = useResource<GiView>(`/api/gate-inward/${id}`);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/gate-inward/${id}/transition`, body),
    { onDone: () => { setRejecting(false); setReason(''); reload(); } },
  );

  const startQc = useMutation(
    async () => api.post('/api/qc', { gate_inward_id: id }),
    { onDone: reload, successMessage: 'Inspection opened.' },
  );

  if (loading) return <LoadingState rows={7} label="Loading the delivery" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { gi, lines, band } = data;

  const isReceiver = Number(gi.received_by) === userId;
  const canHandOver = gi.status === 'INWARD_RECEIVED' && granted.includes('GATE_INWARD.SEND_TO_QC');
  const canReject = gi.status === 'INWARD_RECEIVED' && granted.includes('GATE_INWARD.REJECT');
  const canInspect = gi.status === 'QC_PENDING' && granted.includes('QC.START') && !isReceiver;

  const totalShort = lines.reduce((s, l) => s + Number(l.qty_short), 0);
  const totalExcess = lines.reduce((s, l) => s + Number(l.qty_excess), 0);

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{gi.gi_no}</span> <StatusChip status={gi.status} />
            </h2>
            <span className="sub">
              {gi.vendor_name} against <Link href={`/po/${gi.po_id}`} className="mono">{gi.po_no}</Link> ·
              challan {gi.challan_no} · received by {gi.received_by_name}
            </span>
          </div>
          {gi.qc_id && (
            <Link className="btn" href={`/qc/${gi.qc_id}`}>Open inspection {gi.qc_no}</Link>
          )}
        </div>

        <div className="pad grid g4">
          <Tile label="Vehicle" value={gi.vehicle_no} hint={gi.transporter ?? undefined} />
          <Tile label="Arrived" value={fmtDateTime(gi.arrived_at)} hint={gi.driver_name ?? undefined} />
          <Tile label="LR / seal" value={`${gi.lr_no ?? '—'} / ${gi.seal_no ?? '—'}`} />
          <Tile label="Site" value={gi.site_name} />
        </div>
      </Card>

      {band.required && (
        <Card title="Cold chain" label="Cold chain">
          <div className="pad">
            {gi.temp_in_tolerance === false ? (
              <Banner kind="bad">
                The reefer ran at {gi.reefer_actual_c} °C, outside the {band.minC} to {band.maxC} °C band
                this cargo requires. Nothing on this delivery can be accepted at inspection — it has to be
                held, and a site manager decides it.
              </Banner>
            ) : (
              <Banner kind="ok">
                The reefer ran at {gi.reefer_actual_c} °C, inside the {band.minC} to {band.maxC} °C band.
              </Banner>
            )}
            <div className="grid g4" style={{ marginTop: 12 }}>
              <Tile label="Set point" value={gi.reefer_set_point_c ? `${gi.reefer_set_point_c} °C` : '—'} />
              <Tile label="Reading" value={gi.reefer_actual_c ? `${gi.reefer_actual_c} °C` : '—'} />
              <Tile
                label="Band"
                value={`${band.minC} to ${band.maxC} °C`}
                hint={band.classes.length > 1 ? `Tightest of ${band.classes.join(', ')}` : band.classes[0]}
              />
              <Tile
                label="Data logger"
                value={band.requiresDataLogger ? 'Required' : 'Not required'}
                hint={band.requiresDataLogger ? 'Must be attached before the verdict' : undefined}
              />
            </div>
          </div>
        </Card>
      )}

      {gi.rejection_reason && <Banner kind="bad">Turned away — {gi.rejection_reason}</Banner>}

      <Card title="What arrived" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <div>Item</div>
            <div className="r">Per challan</div>
            <div className="r">Counted</div>
            <div className="r">Difference</div>
            <div>Unit</div>
          </div>
          {lines.map(l => {
            const short = Number(l.qty_short);
            const excess = Number(l.qty_excess);
            return (
              <div key={l.id} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div>
                  <span className="mono">{l.item_code}</span>
                  <div className="sub">
                    {l.item_name}
                    {l.is_cold_chain && ` · ${l.item_class_code} cold chain`}
                  </div>
                </div>
                <div className="r">{fmtQty(l.qty_per_challan)}</div>
                <div className="r"><strong>{fmtQty(l.qty_counted)}</strong></div>
                <div className="r">
                  {short > 0 ? (
                    <span className="chip warn">short {fmtQty(short)}</span>
                  ) : excess > 0 ? (
                    <span className="chip warn">excess {fmtQty(excess)}</span>
                  ) : (
                    <span className="chip ok">matches</span>
                  )}
                </div>
                <div className="sub">{l.uom}</div>
              </div>
            );
          })}
        </div>

        {(totalShort > 0 || totalExcess > 0) && (
          <div className="pad sub" style={{ borderTop: '1px solid var(--line-2)' }}>
            {totalShort > 0 && (
              <>
                Short by {fmtQty(totalShort)} against the challan — a shortfall case is raised when this goes
                to QC.{' '}
              </>
            )}
            {totalExcess > 0 && (
              <>
                {fmtQty(totalExcess)} more than the challan claimed. It is recorded as counted; whether it can
                be received at all is settled at goods receipt.
              </>
            )}
          </div>
        )}
      </Card>

      <Documents
        entityType="GATE_INWARD"
        entityId={gi.id}
        required={
          band.requiresDataLogger
            ? [{
                type: 'DATA_LOGGER',
                why: `${band.classes.join(', ')} needs its logger file before the inspection can be completed`,
              }]
            : []
        }
        offered={['CHALLAN', 'PHOTO', 'DATA_LOGGER']}
        canAttach={gi.status !== 'INWARD_REJECTED'}
      />

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}
          {startQc.error && <Banner kind="bad">{startQc.error}</Banner>}

          {canHandOver && !rejecting && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Handing over to QC closes the count. Anything short raises a shortfall case at the same
                moment, so the gap is settled separately from the question of quality.
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'send-to-qc' })}>
                  {act.busy ? 'Handing over…' : 'Hand over to QC'}
                </button>
                {canReject && <button type="button" className="btn" onClick={() => setRejecting(true)}>Turn the vehicle away</button>}
              </div>
            </>
          )}

          {rejecting && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'reject', reason });
              }}
            >
              <div className="field">
                <label htmlFor="gi-reject">Why is this being turned away?</label>
                <textarea id="gi-reject" className="inp" rows={3} value={reason} onChange={e => setReason(e.target.value)} required minLength={4} />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || reason.trim().length < 4}>
                  {act.busy ? 'Recording…' : 'Confirm'}
                </button>
                <button type="button" className="btn" onClick={() => setRejecting(false)}>Cancel</button>
              </div>
            </form>
          )}

          {gi.status === 'QC_PENDING' && (
            canInspect ? (
              <>
                <p className="sub" style={{ marginTop: 0 }}>
                  Opening an inspection copies the counted quantities across and starts the SLA clock —
                  four hours for cold chain, forty-eight for ambient.
                </p>
                <button type="button" className="btn btn-primary" disabled={startQc.busy} onClick={() => void startQc.run(undefined)}>
                  {startQc.busy ? 'Opening…' : 'Start the inspection'}
                </button>
              </>
            ) : isReceiver ? (
              <Banner kind="warn">
                You logged this delivery in, so somebody else has to inspect it.
              </Banner>
            ) : (
              <Banner kind="info">This delivery is waiting for an inspector.</Banner>
            )
          )}

          {gi.status === 'QC_COMPLETED' && gi.qc_id && (
            <Banner kind="ok">
              Inspected. <Link href={`/qc/${gi.qc_id}`}>Open {gi.qc_no}</Link> to see the verdict and raise
              the goods receipt.
            </Banner>
          )}
        </div>
      </Card>
    </>
  );
}
