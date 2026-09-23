'use client';

/**
 * Stock transfer detail — request, decide, dispatch, receive.
 *
 * Each of the last three posts stock movements through `post_stock_movement()`:
 * approval reserves at the holding site, dispatch moves reserved to in-transit,
 * receipt lands it as available at the destination. Nothing here writes a
 * balance; the ledger does, and the balances follow.
 *
 * Receipt may be short. What was sent but did not arrive is released back to
 * available at the holding site rather than disappearing — that is the amendment
 * recorded as conflict C-01, and the reason a short receipt is a normal outcome
 * here rather than an error.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Steps,
  Tile, fmtDateTime, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Row { [k: string]: unknown }

interface TransferView {
  transfer: Row & {
    id: number; transfer_no: string; status: string;
    from_site_id: number; from_code: string; from_name: string;
    to_site_id: number; to_code: string; to_name: string;
    mr_id: number | null; mr_no: string | null;
    requested_by: number; requested_by_name: string;
    decided_by_name: string | null; decided_at: string | null;
    received_by_name: string | null; received_at: string | null;
    rejection_reason: string | null; created_at: string;
  };
  lines: (Row & {
    id: number; item_code: string; item_name: string; uom: string;
    qty: string; qty_received: string | null;
  })[];
}

const COLS = '1fr 130px 130px 80px';

const STAGES = [
  { label: 'Requested', sub: 'By the receiving site', reached: ['TRF_REQUESTED'] },
  { label: 'Approved', sub: 'Stock reserved', reached: ['TRF_APPROVED'] },
  { label: 'Dispatched', sub: 'In transit', reached: ['TRF_DISPATCHED'] },
  { label: 'Received', sub: 'Available at destination', reached: ['TRF_RECEIVED'] },
];

export function TransferDetail({
  id,
  granted,
  userId,
  siteIds,
}: {
  id: number;
  granted: string[];
  userId: number;
  siteIds: number[];
}) {
  const { data, loading, error, reload } = useResource<TransferView>(`/api/transfers/${id}`);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [receipts, setReceipts] = useState<Record<number, string>>({});

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/transfers/${id}/transition`, body),
    { onDone: () => { setRejecting(false); setReason(''); reload(); } },
  );

  if (loading) return <LoadingState rows={7} label="Loading the transfer" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { transfer: t, lines } = data;
  const at = STAGES.findIndex(s => s.reached.includes(t.status));

  const isRequester = Number(t.requested_by) === userId;
  const atHoldingSite = siteIds.includes(Number(t.from_site_id));
  const atDestination = siteIds.includes(Number(t.to_site_id));

  // Each gate is the union of "the status allows it", "you hold the permission"
  // and "you are at the right end of the move". The server checks all three
  // again; this only decides what to draw.
  const canDecide = t.status === 'TRF_REQUESTED' && granted.includes('TRANSFER.DECIDE') && atHoldingSite && !isRequester;
  const canDispatch = t.status === 'TRF_APPROVED' && granted.includes('TRANSFER.DISPATCH') && atHoldingSite;
  const canReceive = t.status === 'TRF_DISPATCHED' && granted.includes('TRANSFER.RECEIVE') && atDestination;

  const receiptBody = () => ({
    action: 'receive',
    received: lines.map(l => ({
      transfer_line_id: l.id,
      qty_received: receipts[l.id] ?? l.qty,
    })),
  });

  const anyShort = lines.some(l => Number(receipts[l.id] ?? l.qty) < Number(l.qty));

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{t.transfer_no}</span> <StatusChip status={t.status} />
            </h2>
            <span className="sub">
              {t.from_name} → {t.to_name} · requested by {t.requested_by_name}
              {t.mr_no && (
                <>
                  {' '}against{' '}
                  <Link href={`/mr/${t.mr_id}`} className="mono">{t.mr_no}</Link>
                </>
              )}
            </span>
          </div>
        </div>

        <div className="pad grid g3">
          <Tile label="Holding site" value={t.from_name} hint={`${t.from_code} — decides and dispatches`} />
          <Tile label="Receiving site" value={t.to_name} hint={`${t.to_code} — confirms arrival`} />
          <Tile
            label="Decided"
            value={t.decided_by_name ?? 'Not yet'}
            hint={t.decided_at ? fmtDateTime(t.decided_at) : undefined}
          />
        </div>
      </Card>

      <Steps
        steps={STAGES.map((s, i) => ({
          label: s.label,
          sub: s.sub,
          state: at < 0 ? 'todo' : i < at ? 'done' : i === at ? 'now' : 'todo',
        }))}
      />

      {t.rejection_reason && (
        <Banner kind="bad">Rejected — {t.rejection_reason}</Banner>
      )}

      <Card title="What is moving" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <div>Item</div>
            <div className="r">Quantity</div>
            <div className="r">{canReceive ? 'Arrived' : 'Received'}</div>
            <div>Unit</div>
          </div>
          {lines.map(l => (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: COLS }}>
              <div>
                <span className="mono">{l.item_code}</span>
                <div className="sub">{l.item_name}</div>
              </div>
              <div className="r">{fmtQty(l.qty)}</div>
              <div className="r">
                {canReceive ? (
                  <>
                    <label htmlFor={`rx-${l.id}`} className="sr-only">
                      Quantity received for {l.item_code}
                    </label>
                    <input
                      id={`rx-${l.id}`}
                      className="inp-sm"
                      inputMode="decimal"
                      value={receipts[l.id] ?? l.qty}
                      onChange={e => setReceipts(r => ({ ...r, [l.id]: e.target.value }))}
                    />
                  </>
                ) : l.qty_received === null ? (
                  <span className="sub">—</span>
                ) : (
                  fmtQty(l.qty_received)
                )}
              </div>
              <div className="sub">{l.uom}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {t.status === 'TRF_REQUESTED' && isRequester && (
            <Banner kind="warn">
              You raised this transfer, so the holding site has to decide it.
            </Banner>
          )}

          {t.status === 'TRF_REQUESTED' && !atHoldingSite && !isRequester && (
            <Banner kind="info">
              Only {t.from_name} can decide this — the stock is theirs until they release it.
            </Banner>
          )}

          {canDecide && !rejecting && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'approve' })}>
                {act.busy ? 'Approving…' : 'Approve and reserve the stock'}
              </button>
              <button type="button" className="btn" onClick={() => setRejecting(true)}>Reject</button>
            </div>
          )}

          {canDecide && rejecting && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'reject', reason });
              }}
            >
              <div className="field">
                <label htmlFor="trf-reject">Why can this not be sent?</label>
                <textarea
                  id="trf-reject"
                  className="inp"
                  rows={3}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  required
                  minLength={4}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || reason.trim().length < 4}>
                  {act.busy ? 'Rejecting…' : 'Confirm rejection'}
                </button>
                <button type="button" className="btn" onClick={() => setRejecting(false)}>Cancel</button>
              </div>
            </form>
          )}

          {canDispatch && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Dispatching moves the reserved stock into transit. It leaves {t.from_name}&rsquo;s available
                balance at that moment, not when it arrives.
              </p>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'dispatch' })}>
                {act.busy ? 'Dispatching…' : 'Dispatch'}
              </button>
            </>
          )}

          {canReceive && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Confirm what actually arrived. Anything short is released back to {t.from_name}&rsquo;s
                available stock rather than written off here.
              </p>
              {anyShort && (
                <Banner kind="warn">
                  Less arrived than was sent. The difference goes back to {t.from_name}.
                </Banner>
              )}
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(receiptBody())}>
                {act.busy ? 'Recording…' : 'Confirm receipt'}
              </button>
            </>
          )}

          {t.status === 'TRF_RECEIVED' && (
            <Banner kind="ok">
              Received{t.received_by_name ? ` by ${t.received_by_name}` : ''}
              {t.received_at ? ` on ${fmtDateTime(t.received_at)}` : ''}. The stock is available at {t.to_name}.
            </Banner>
          )}
        </div>
      </Card>
    </>
  );
}
