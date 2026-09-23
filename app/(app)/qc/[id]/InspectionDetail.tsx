'use client';

/**
 * The inspection itself.
 *
 * Each line splits the delivered quantity three ways — accepted, held, rejected
 * — and the split must add up, which is `qc_lines_sum`. The running total is
 * shown as it is typed so the constraint is met before the round trip rather
 * than reported after it.
 *
 * The delivered quantity is read-only and always will be: it came from the gate
 * count when the inspection opened, and letting an inspector change it would
 * mean inspecting a quantity nobody delivered (C-10).
 *
 * On a cold-chain breach the accept column is closed off entirely, because
 * nothing on a breached load can be accepted outright (C-11) — it goes to hold
 * and a site manager decides it.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDateTime, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Row { [k: string]: unknown }

interface QcView {
  qc: Row & {
    id: number; qc_no: string; gate_inward_id: number; gi_no: string; gi_status: string;
    po_id: number; po_no: string; vendor_name: string; site_name: string;
    challan_no: string; vehicle_no: string; inspector_id: number; inspector_name: string;
    started_at: string; completed_at: string | null; sla_due_at: string; overdue: boolean;
    temp_in_tolerance: boolean | null; reefer_actual_c: string | null;
    reinspection_of_no: string | null; received_by: number;
  };
  lines: (Row & {
    id: number; item_code: string; item_name: string; uom: string; checklist_id: number;
    checklist_version: string; qty_delivered: string; qty_accepted: string;
    qty_hold: string; qty_rejected: string; reason_code: string | null; remarks: string | null;
    hold_decision: string | null; hold_decision_qty: string | null;
    hold_decision_reason: string | null; hold_decided_by_name: string | null;
  })[];
  points: (Row & { id: number; checklist_id: number; point_no: number; description: string })[];
}

const NOT_YET = 'PENDING_INSPECTION';
const COLS = '1fr 100px 110px 110px 110px 1fr';

const REASONS = [
  'SURFACE_DAMAGE',
  'SHORT_WEIGHT',
  'WRONG_MAKE',
  'PACKAGING_FAILURE',
  'COLD_CHAIN_BREACH',
  'EXPIRY_TOO_SOON',
  'SPECIFICATION_MISMATCH',
];

interface Draft {
  accepted: string;
  hold: string;
  rejected: string;
  reason: string;
  remarks: string;
}

export function InspectionDetail({ id, granted, userId }: { id: number; granted: string[]; userId: number }) {
  const { data, loading, error, reload } = useResource<QcView>(`/api/qc/${id}`);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>({ accepted: '', hold: '', rejected: '', reason: '', remarks: '' });
  const [checks, setChecks] = useState<Record<number, 'PASS' | 'FAIL' | 'NA'>>({});

  const save = useMutation(
    async (line: { id: number; checklistId: number }) =>
      api.put(`/api/qc/${id}/lines`, {
        qc_line_id: line.id,
        qty_accepted: draft.accepted || '0',
        qty_hold: draft.hold || '0',
        qty_rejected: draft.rejected || '0',
        reason_code: draft.reason || null,
        remarks: draft.remarks || null,
        checks: Object.entries(checks).map(([pointId, result]) => ({ point_id: Number(pointId), result })),
      }),
    { onDone: () => { setEditing(null); setChecks({}); reload(); } },
  );

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/qc/${id}/transition`, body),
    { onDone: reload },
  );

  if (loading) return <LoadingState rows={8} label="Loading the inspection" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { qc, lines, points } = data;

  const isInspector = Number(qc.inspector_id) === userId;
  const open = qc.completed_at === null;
  const canEdit = open && granted.includes('QC.EDIT') && isInspector;
  const breached = qc.temp_in_tolerance === false;

  const uninspected = lines.filter(l => l.reason_code === NOT_YET);
  const canComplete = open && granted.includes('QC.COMPLETE') && isInspector && uninspected.length === 0;
  const canReinspect = !open && granted.includes('QC.REINSPECT') && Number(qc.received_by) !== userId;

  const totals = lines.reduce(
    (acc, l) => ({
      accepted: acc.accepted + Number(l.qty_accepted),
      hold: acc.hold + Number(l.qty_hold),
      rejected: acc.rejected + Number(l.qty_rejected),
    }),
    { accepted: 0, hold: 0, rejected: 0 },
  );

  const beginEdit = (line: QcView['lines'][number]) => {
    const fresh = line.reason_code === NOT_YET;
    setEditing(line.id);
    setDraft({
      accepted: fresh ? '' : line.qty_accepted,
      hold: fresh ? '' : line.qty_hold,
      rejected: fresh ? '' : line.qty_rejected,
      reason: fresh || !line.reason_code ? '' : line.reason_code,
      remarks: line.remarks ?? '',
    });
    setChecks({});
  };

  const draftSum = Number(draft.accepted || 0) + Number(draft.hold || 0) + Number(draft.rejected || 0);

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{qc.qc_no}</span>{' '}
              <StatusChip status={open ? 'QC_IN_PROGRESS' : 'QC_COMPLETED'} />
            </h2>
            <span className="sub">
              {qc.vendor_name} · <Link href={`/gate-inward/${qc.gate_inward_id}`} className="mono">{qc.gi_no}</Link> ·
              challan {qc.challan_no} · inspector {qc.inspector_name}
              {qc.reinspection_of_no && <> · re-inspection after {qc.reinspection_of_no}</>}
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile label="Started" value={fmtDateTime(qc.started_at)} hint={qc.site_name} />
          <Tile
            label="SLA"
            value={open ? fmtDateTime(qc.sla_due_at) : 'Met'}
            hint={qc.overdue ? 'Past due' : open ? 'Due by' : fmtDateTime(qc.completed_at ?? '')}
          />
          <Tile label="Accepted" value={fmtQty(totals.accepted)} />
          <Tile
            label="Held / rejected"
            value={`${fmtQty(totals.hold)} / ${fmtQty(totals.rejected)}`}
            hint={totals.hold + totals.rejected > 0 ? 'Waiting on a decision' : undefined}
          />
        </div>
      </Card>

      {breached && (
        <Banner kind="bad">
          The reefer ran at {qc.reefer_actual_c} °C, outside the band for this cargo. Nothing here can be
          accepted outright — hold it, and a site manager decides whether to take it on concession.
        </Banner>
      )}

      {qc.overdue && open && <Banner kind="warn">This inspection is past its SLA.</Banner>}

      <Card title="Lines" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <div>Item</div>
            <div className="r">Delivered</div>
            <div className="r">Accepted</div>
            <div className="r">Held</div>
            <div className="r">Rejected</div>
            <div>Reason and decision</div>
          </div>

          {lines.map(line => {
            const fresh = line.reason_code === NOT_YET;
            const isEditing = editing === line.id;

            return (
              <div key={line.id}>
                <div className="tr" style={{ gridTemplateColumns: COLS }}>
                  <div>
                    <span className="mono">{line.item_code}</span>
                    <div className="sub">
                      {line.item_name} · checklist {line.checklist_version}
                    </div>
                  </div>
                  <div className="r">
                    {fmtQty(line.qty_delivered)} <span className="sub">{line.uom}</span>
                  </div>
                  <div className="r">{fresh ? <span className="sub">—</span> : fmtQty(line.qty_accepted)}</div>
                  <div className="r">{fresh ? <span className="sub">—</span> : fmtQty(line.qty_hold)}</div>
                  <div className="r">{fresh ? <span className="sub">—</span> : fmtQty(line.qty_rejected)}</div>
                  <div>
                    {fresh ? (
                      <span className="sub">Not inspected yet</span>
                    ) : (
                      <>
                        <span className="mono">{line.reason_code ?? '—'}</span>
                        {line.remarks && <div className="sub">{line.remarks}</div>}
                        {line.hold_decision && (
                          <div className="sub">
                            <strong>{line.hold_decision.toLowerCase()}</strong> on{' '}
                            {fmtQty(line.hold_decision_qty)} by {line.hold_decided_by_name} —{' '}
                            {line.hold_decision_reason}
                          </div>
                        )}
                      </>
                    )}
                    {canEdit && !isEditing && (
                      <button type="button" className="btn btn-sm" onClick={() => beginEdit(line)}>
                        {fresh ? 'Inspect' : 'Change'}
                      </button>
                    )}
                  </div>
                </div>

                {isEditing && (
                  <form
                    className="pad"
                    style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--line-2)' }}
                    onSubmit={e => {
                      e.preventDefault();
                      void save.run({ id: line.id, checklistId: Number(line.checklist_id) });
                    }}
                  >
                    {save.error && <Banner kind="bad">{save.error}</Banner>}

                    <div className="grid g4">
                      <div className="field">
                        <label htmlFor={`qc-a-${line.id}`}>Accepted</label>
                        <input
                          id={`qc-a-${line.id}`}
                          className="inp"
                          inputMode="decimal"
                          value={draft.accepted}
                          disabled={breached}
                          onChange={e => setDraft(d => ({ ...d, accepted: e.target.value }))}
                        />
                        {breached && <span className="sub">Closed off — the load breached its temperature band.</span>}
                      </div>
                      <div className="field">
                        <label htmlFor={`qc-h-${line.id}`}>Held</label>
                        <input
                          id={`qc-h-${line.id}`}
                          className="inp"
                          inputMode="decimal"
                          value={draft.hold}
                          onChange={e => setDraft(d => ({ ...d, hold: e.target.value }))}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`qc-r-${line.id}`}>Rejected</label>
                        <input
                          id={`qc-r-${line.id}`}
                          className="inp"
                          inputMode="decimal"
                          value={draft.rejected}
                          onChange={e => setDraft(d => ({ ...d, rejected: e.target.value }))}
                        />
                      </div>
                      <div className="field">
                        <span className="lbl">Adds up to</span>
                        <div style={{ paddingTop: 8 }}>
                          <span className={Math.abs(draftSum - Number(line.qty_delivered)) > 0.0005 ? 'chip bad' : 'chip ok'}>
                            {fmtQty(draftSum)} of {fmtQty(line.qty_delivered)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {(Number(draft.hold || 0) > 0 || Number(draft.rejected || 0) > 0) && (
                      <div className="grid g2">
                        <div className="field">
                          <label htmlFor={`qc-reason-${line.id}`}>Reason code</label>
                          <select
                            id={`qc-reason-${line.id}`}
                            className="inp"
                            value={draft.reason}
                            onChange={e => setDraft(d => ({ ...d, reason: e.target.value }))}
                            required
                          >
                            <option value="">Choose…</option>
                            {REASONS.map(r => (
                              <option key={r} value={r}>{r.replace(/_/g, ' ').toLowerCase()}</option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor={`qc-remarks-${line.id}`}>Remarks</label>
                          <input
                            id={`qc-remarks-${line.id}`}
                            className="inp"
                            value={draft.remarks}
                            onChange={e => setDraft(d => ({ ...d, remarks: e.target.value }))}
                            maxLength={1000}
                            placeholder="What you saw."
                          />
                        </div>
                      </div>
                    )}

                    <h4 style={{ margin: '14px 0 6px' }}>Checklist {line.checklist_version}</h4>
                    {points
                      .filter(p => Number(p.checklist_id) === Number(line.checklist_id))
                      .map(p => (
                        <div key={p.id} style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
                          <span style={{ flex: 1 }}>
                            <span className="sub">{p.point_no}.</span> {p.description}
                          </span>
                          <div className="seg" role="radiogroup" aria-label={p.description}>
                            {(['PASS', 'FAIL', 'NA'] as const).map(result => (
                              <button
                                key={result}
                                type="button"
                                className="btn btn-sm"
                                role="radio"
                                aria-checked={checks[p.id] === result}
                                onClick={() => setChecks(c => ({ ...c, [p.id]: result }))}
                              >
                                {result}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}

                    <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                      <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={save.busy || Math.abs(draftSum - Number(line.qty_delivered)) > 0.0005}
                      >
                        {save.busy ? 'Saving…' : 'Record the verdict'}
                      </button>
                      <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {open && !isInspector && (
            <Banner kind="info">
              {qc.inspector_name} is inspecting this. Only they can record a verdict on it.
            </Banner>
          )}

          {open && isInspector && uninspected.length > 0 && (
            <Banner kind="warn">
              {uninspected.map(l => l.item_code).join(', ')} still{' '}
              {uninspected.length === 1 ? 'needs' : 'need'} a verdict.
            </Banner>
          )}

          {canComplete && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Completing closes the inspection. Anything held then waits for a site manager before a goods
                receipt can be raised.
              </p>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'complete' })}>
                {act.busy ? 'Completing…' : 'Complete the inspection'}
              </button>
            </>
          )}

          {!open && (
            <>
              <Banner kind="ok">
                Completed {fmtDateTime(qc.completed_at ?? '')}. {fmtQty(totals.accepted)} accepted,{' '}
                {fmtQty(totals.hold)} held, {fmtQty(totals.rejected)} rejected.
              </Banner>
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                {granted.includes('GRN.CREATE') && totals.accepted + totals.hold > 0 && (
                  <Link className="btn btn-primary" href={`/grn?from_qc=${qc.id}`}>Raise the goods receipt</Link>
                )}
                {canReinspect && (
                  <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run({ action: 'reinspect' })}>
                    {act.busy ? 'Opening…' : 'Re-inspect'}
                  </button>
                )}
              </div>
              {canReinspect && (
                <p className="sub" style={{ marginBottom: 0 }}>
                  A re-inspection is a new record chained to this one. This verdict stays exactly as it is.
                </p>
              )}
            </>
          )}
        </div>
      </Card>
    </>
  );
}
