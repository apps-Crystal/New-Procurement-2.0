'use client';

/**
 * Goods receipt detail — the approval that creates stock.
 *
 * Three people appear on this screen by design: whoever received the delivery,
 * whoever inspected it, and whoever approves the receipt. `grns_segregation`
 * requires all three to differ, so they are shown together rather than buried,
 * and the approve button explains itself when the viewer is one of the first two.
 *
 * An over-receipt blocks approval (C-09). The excess is listed with the numbers
 * behind it — ordered, already received, on this receipt — because "more than
 * was ordered" is only actionable if you can see by how much.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDateTime, fmtMoney, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Row { [k: string]: unknown }

interface GrnView {
  grn: Row & {
    id: number; grn_no: string; status: string; site_name: string;
    po_id: number; po_no: string; vendor_name: string;
    gate_inward_id: number | null; gi_no: string | null; challan_no: string | null;
    vehicle_no: string | null; received_by: number | null; received_by_name: string | null;
    qc_id: number | null; qc_no: string | null; inspector_id: number | null; inspector_name: string | null;
    approved_by_name: string | null; approved_at: string | null;
    flag_reason: string | null; rejection_reason: string | null; created_at: string;
  };
  lines: (Row & {
    id: number; item_code: string; item_name: string; uom: string;
    qty_accepted: string; qty_concession: string; unit_rate: string; line_value: string;
    qty_ordered: string; qty_received: string | null; qty_outstanding: string | null;
    location_code: string | null; stock_entry_id: number | null;
  })[];
  excess: {
    poLineId: number; itemCode: string; qtyOrdered: string;
    qtyAlreadyReceived: string; qtyOnThisGrn: string; excess: string;
  }[];
}

const COLS = '1fr 120px 120px 130px 120px';

export function GrnDetail({ id, granted, userId }: { id: number; granted: string[]; userId: number }) {
  const { data, loading, error, reload } = useResource<GrnView>(`/api/grn/${id}`);
  const [prompt, setPrompt] = useState<'flag' | 'reject' | null>(null);
  const [reason, setReason] = useState('');

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/grn/${id}/transition`, body),
    { onDone: () => { setPrompt(null); setReason(''); reload(); } },
  );

  if (loading) return <LoadingState rows={8} label="Loading the receipt" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { grn, lines, excess } = data;

  const wasReceiver = grn.received_by !== null && Number(grn.received_by) === userId;
  const wasInspector = grn.inspector_id !== null && Number(grn.inspector_id) === userId;
  const draftOrFlagged = grn.status === 'GRN_DRAFT' || grn.status === 'GRN_FLAGGED';

  const canApprove =
    grn.status === 'GRN_DRAFT' && granted.includes('GRN.APPROVE') && !wasReceiver && !wasInspector;
  const canFlag = draftOrFlagged && granted.includes('GRN.FLAG') && grn.status === 'GRN_DRAFT';
  const canUnflag = grn.status === 'GRN_FLAGGED' && granted.includes('GRN.UNFLAG');
  const canClose = grn.status === 'GRN_APPROVED' && granted.includes('GRN.CLOSE');

  const totalValue = lines.reduce((s, l) => s + Number(l.line_value), 0);
  const totalAccepted = lines.reduce((s, l) => s + Number(l.qty_accepted), 0);
  const totalConcession = lines.reduce((s, l) => s + Number(l.qty_concession), 0);

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{grn.grn_no}</span> <StatusChip status={grn.status} />
            </h2>
            <span className="sub">
              {grn.vendor_name} against <Link href={`/po/${grn.po_id}`} className="mono">{grn.po_no}</Link>
              {grn.gi_no && grn.gate_inward_id && (
                <> · <Link href={`/gate-inward/${grn.gate_inward_id}`} className="mono">{grn.gi_no}</Link></>
              )}
              {grn.qc_no && grn.qc_id && (
                <> · <Link href={`/qc/${grn.qc_id}`} className="mono">{grn.qc_no}</Link></>
              )}
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile label="Received at the gate by" value={grn.received_by_name ?? '—'} hint={grn.challan_no ? `Challan ${grn.challan_no}` : undefined} />
          <Tile label="Inspected by" value={grn.inspector_name ?? '—'} />
          <Tile
            label="Approved by"
            value={grn.approved_by_name ?? 'Not yet'}
            hint={grn.approved_at ? fmtDateTime(grn.approved_at) : 'All three must differ'}
          />
          <Tile label="Value" value={`₹${fmtMoney(totalValue)}`} hint={`${fmtQty(totalAccepted)} accepted`} />
        </div>
      </Card>

      {grn.flag_reason && <Banner kind="warn">Flagged — {grn.flag_reason}</Banner>}
      {grn.rejection_reason && <Banner kind="bad">Rejected — {grn.rejection_reason}</Banner>}

      {excess.length > 0 && (
        <Card title="More than was ordered" label="Over-receipt">
          <div className="pad">
            <Banner kind="bad">
              This receipt cannot be approved as it stands. Accepting it would take the order past what was
              ordered, and the purchase order has to be amended first.
            </Banner>
            <div className="tbl" style={{ marginTop: 12 }}>
              <div className="tr th" style={{ gridTemplateColumns: '1fr 110px 130px 130px 110px' }}>
                <div>Item</div>
                <div className="r">Ordered</div>
                <div className="r">Already received</div>
                <div className="r">On this receipt</div>
                <div className="r">Excess</div>
              </div>
              {excess.map(e => (
                <div key={e.poLineId} className="tr" style={{ gridTemplateColumns: '1fr 110px 130px 130px 110px' }}>
                  <div className="mono">{e.itemCode}</div>
                  <div className="r">{fmtQty(e.qtyOrdered)}</div>
                  <div className="r">{fmtQty(e.qtyAlreadyReceived)}</div>
                  <div className="r">{fmtQty(e.qtyOnThisGrn)}</div>
                  <div className="r"><span className="chip bad">{fmtQty(e.excess)}</span></div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      <Card title="What is being received" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <div>Item</div>
            <div className="r">Accepted</div>
            <div className="r">Rate</div>
            <div className="r">Value</div>
            <div>Put away</div>
          </div>
          {lines.map(l => (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: COLS }}>
              <div>
                <span className="mono">{l.item_code}</span>
                <div className="sub">{l.item_name}</div>
                {Number(l.qty_concession) > 0 && (
                  <div className="sub">
                    <strong>{fmtQty(l.qty_concession)} on concession</strong> — accepted despite the inspection
                  </div>
                )}
              </div>
              <div className="r">
                {fmtQty(l.qty_accepted)} <span className="sub">{l.uom}</span>
              </div>
              <div className="r">₹{fmtMoney(l.unit_rate)}</div>
              <div className="r">₹{fmtMoney(l.line_value)}</div>
              <div className="sub">
                {l.location_code ?? '—'}
                {l.stock_entry_id && <div>ledger #{l.stock_entry_id}</div>}
              </div>
            </div>
          ))}
        </div>
        {totalConcession > 0 && (
          <div className="pad sub" style={{ borderTop: '1px solid var(--line-2)' }}>
            {fmtQty(totalConcession)} of this receipt was taken on concession — material that failed
            inspection and was accepted anyway by a site manager. It stays recorded separately so the
            decision can still be found later.
          </div>
        )}
      </Card>

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {grn.status === 'GRN_DRAFT' && (wasReceiver || wasInspector) && (
            <Banner kind="warn">
              You {wasReceiver ? 'received this delivery at the gate' : 'inspected this delivery'}, so the
              receipt has to be approved by somebody else. The database enforces that too.
            </Banner>
          )}

          {canApprove && !prompt && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Approving posts every line to the stock ledger. That is the moment this material becomes
                inventory — nothing before it counts.
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={act.busy || excess.length > 0}
                  onClick={() => void act.run({ action: 'approve' })}
                >
                  {act.busy ? 'Approving…' : 'Approve and post the stock'}
                </button>
                {canFlag && <button type="button" className="btn" onClick={() => setPrompt('flag')}>Flag it</button>}
                <button type="button" className="btn" onClick={() => setPrompt('reject')}>Reject</button>
              </div>
            </>
          )}

          {prompt && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: prompt, reason });
              }}
            >
              <div className="field">
                <label htmlFor="grn-reason">
                  {prompt === 'flag' ? 'What has to be settled first?' : 'Why is this being rejected?'}
                </label>
                <textarea id="grn-reason" className="inp" rows={3} value={reason} onChange={e => setReason(e.target.value)} required minLength={4} />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || reason.trim().length < 4}>
                  {act.busy ? 'Saving…' : prompt === 'flag' ? 'Flag the receipt' : 'Confirm rejection'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {canUnflag && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Releasing sends it back to draft so it can be approved. Do this once whatever the flag named
                has actually been settled.
              </p>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'unflag' })}>
                {act.busy ? 'Releasing…' : 'Release the flag'}
              </button>
            </>
          )}

          {grn.status === 'GRN_APPROVED' && (
            <>
              <Banner kind="ok">
                Approved by {grn.approved_by_name} on {fmtDateTime(grn.approved_at ?? '')}. The stock is at{' '}
                {grn.site_name}.
              </Banner>
              {canClose && (
                <button type="button" className="btn" style={{ marginTop: 10 }} disabled={act.busy} onClick={() => void act.run({ action: 'close' })}>
                  {act.busy ? 'Closing…' : 'Close the receipt'}
                </button>
              )}
            </>
          )}
        </div>
      </Card>
    </>
  );
}
