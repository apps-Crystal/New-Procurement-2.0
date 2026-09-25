'use client';

/**
 * A purchase return, through to acknowledgement.
 *
 * The screen says plainly whether approving will move stock, because the three
 * origins look identical otherwise and only one of them does. Getting that
 * wrong in either direction is how inventory quietly doubles or disappears.
 *
 * The PRN and the gate pass are minted together at approval, not at dispatch:
 * `rtv_approved_docs` requires both from that point on, and the gate needs the
 * pass in hand before the lorry arrives.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Steps, Tile,
  fmtDate, fmtDateTime, fmtMoney, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { Documents } from '@/components/Documents';

interface Row { [k: string]: unknown }

interface RtvView {
  rtv: Row & {
    id: number; rtv_no: string; status: string; source: string; basis: string;
    site_name: string; vendor_name: string; vendor_code: string;
    vendor_gstin: string | null; vendor_address: string | null;
    po_no: string; po_id: number;
    prn_no: string | null; gate_pass_no: string | null; vendor_rma_no: string | null;
    transporter: string | null; lr_no: string | null; eway_bill_no: string | null;
    raised_by: number; raised_by_name: string; approved_by_name: string | null;
    approved_at: string | null; dispatched_at: string | null;
    acknowledged_at: string | null; closed_at: string | null;
    cancelled_reason: string | null; created_at: string;
    qc_no: string | null; dmg_no: string | null; sht_no: string | null;
  };
  lines: (Row & {
    id: number; item_code: string; item_name: string; uom: string;
    qty: string; unit_rate: string; gst_rate: string;
    line_taxable: string; line_total: string;
    reason_code: string; reversal_entry_no: string | null;
  })[];
}

const COLS = '1fr 110px 120px 130px 160px';

const STAGES = [
  { label: 'Raised', sub: 'Against its origin', reached: ['RTV_DRAFT'] },
  { label: 'Approved', sub: 'PRN and gate pass', reached: ['RTV_APPROVED'] },
  { label: 'Dispatched', sub: 'Gone to the vendor', reached: ['RTV_DISPATCHED'] },
  { label: 'Acknowledged', sub: 'Vendor confirmed', reached: ['RTV_ACKNOWLEDGED'] },
  { label: 'Closed', sub: 'Credit or replacement settled', reached: ['RTV_CLOSED'] },
];

const SOURCE_LABEL: Record<string, string> = {
  QC_REJECTION: 'QC rejection',
  WAREHOUSE_DAMAGE: 'Warehouse damage',
  SHORTFALL: 'Shortfall',
};

/** Only warehouse damage ever entered stock, so only it has anything to reverse. */
function movesStock(source: string): boolean {
  return source === 'WAREHOUSE_DAMAGE';
}

export function ReturnDetail({ id, granted, userId }: { id: number; granted: string[]; userId: number }) {
  const { data, loading, error, reload } = useResource<RtvView>(`/api/rtv/${id}`);
  const [prompt, setPrompt] = useState<'dispatch' | 'acknowledge' | 'cancel' | null>(null);
  const [form, setForm] = useState({ transporter: '', lrNo: '', ewayBillNo: '', rma: '', reason: '' });

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/rtv/${id}/transition`, body),
    { onDone: () => { setPrompt(null); reload(); } },
  );

  if (loading) return <LoadingState rows={8} label="Loading the return" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { rtv, lines } = data;
  const at = STAGES.findIndex(s => s.reached.includes(rtv.status));

  const isRaiser = Number(rtv.raised_by) === userId;
  const reverses = movesStock(rtv.source);

  const canApprove = rtv.status === 'RTV_DRAFT' && granted.includes('RTV.APPROVE') && !isRaiser;
  const canDispatch = rtv.status === 'RTV_APPROVED' && granted.includes('RTV.DISPATCH');
  const canAcknowledge = rtv.status === 'RTV_DISPATCHED' && granted.includes('RTV.ACKNOWLEDGE');
  const canClose = rtv.status === 'RTV_ACKNOWLEDGED' && granted.includes('RTV.CLOSE');
  const canCancel =
    (rtv.status === 'RTV_DRAFT' || rtv.status === 'RTV_APPROVED') && granted.includes('RTV.CANCEL');

  const originRef = rtv.qc_no ?? rtv.dmg_no ?? rtv.sht_no;
  const total = lines.reduce((s, l) => s + Number(l.line_total), 0);

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{rtv.rtv_no}</span> <StatusChip status={rtv.status} />
            </h2>
            <span className="sub">
              {rtv.vendor_name} · {SOURCE_LABEL[rtv.source] ?? rtv.source}
              {originRef && <> from <span className="mono">{originRef}</span></>} ·{' '}
              against <Link href={`/po/${rtv.po_id}`} className="mono">{rtv.po_no}</Link> ·
              raised by {rtv.raised_by_name} on {fmtDate(rtv.created_at)}
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile label="Basis" value={rtv.basis.replace(/_/g, ' ').toLowerCase()} hint={`${rtv.site_name}`} />
          <Tile
            label="PRN"
            value={rtv.prn_no ?? 'Not yet'}
            hint={rtv.prn_no ? 'The commercial record' : 'Minted on approval'}
          />
          <Tile
            label="Gate pass"
            value={rtv.gate_pass_no ?? 'Not yet'}
            hint={rtv.gate_pass_no ? 'What it travels on' : 'Minted on approval'}
          />
          <Tile label="Value" value={`₹${fmtMoney(total)}`} hint="Including GST" />
        </div>

        {(rtv.transporter || rtv.vendor_rma_no) && (
          <div className="pad grid g4" style={{ paddingTop: 0 }}>
            <Tile label="Transporter" value={rtv.transporter ?? '—'} hint={rtv.lr_no ? `LR ${rtv.lr_no}` : undefined} />
            <Tile label="E-way bill" value={rtv.eway_bill_no ?? '—'} />
            <Tile label="Vendor RMA" value={rtv.vendor_rma_no ?? '—'} hint={rtv.acknowledged_at ? fmtDateTime(rtv.acknowledged_at) : undefined} />
            <Tile label="Approved by" value={rtv.approved_by_name ?? '—'} hint={rtv.approved_at ? fmtDateTime(rtv.approved_at) : undefined} />
          </div>
        )}
      </Card>

      {rtv.status !== 'RTV_CANCELLED' && (
        <Steps
          steps={STAGES.map((s, i) => ({
            label: s.label,
            sub: s.sub,
            state: at < 0 ? 'todo' : i < at ? 'done' : i === at ? 'now' : 'todo',
          }))}
        />
      )}

      {rtv.cancelled_reason && <Banner kind="bad">Cancelled — {rtv.cancelled_reason}</Banner>}

      <Card title="What is going back" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <div>Item and reason</div>
            <div className="r">Quantity</div>
            <div className="r">Rate</div>
            <div className="r">Value</div>
            <div>Stock effect</div>
          </div>
          {lines.map(l => (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: COLS }}>
              <div>
                <span className="mono">{l.item_code}</span>
                <div className="sub">
                  {l.item_name} · {l.reason_code.replace(/_/g, ' ').toLowerCase()}
                </div>
              </div>
              <div className="r">
                {fmtQty(l.qty)} <span className="sub">{l.uom}</span>
              </div>
              <div className="r">₹{fmtMoney(l.unit_rate)}</div>
              <div className="r">₹{fmtMoney(l.line_total)}</div>
              <div className="sub">
                {l.reversal_entry_no ? (
                  <>
                    <span className="mono">{l.reversal_entry_no}</span>
                    <div>out of damaged hold</div>
                  </>
                ) : reverses ? (
                  'on approval'
                ) : (
                  'none — never entered stock'
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Documents
        entityType="RTV"
        entityId={rtv.id}
        offered={['GATE_PASS', 'PRN', 'PHOTO', 'EWAY_BILL']}
        canAttach={rtv.status !== 'RTV_CANCELLED'}
      />

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {rtv.status === 'RTV_DRAFT' && (
            <Banner kind={reverses ? 'warn' : 'info'}>
              {reverses
                ? 'Approving mints the PRN and the gate pass, and takes this stock out of damaged hold. That is the moment it leaves the books.'
                : 'Approving mints the PRN and the gate pass. No stock moves: this material never entered inventory, so there is nothing to take out.'}
            </Banner>
          )}

          {rtv.status === 'RTV_DRAFT' && isRaiser && (
            <Banner kind="warn">
              You raised this return, so somebody else has to approve it.
            </Banner>
          )}

          {canApprove && !prompt && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'approve' })}>
                {act.busy ? 'Approving…' : 'Approve the return'}
              </button>
              {canCancel && <button type="button" className="btn" onClick={() => setPrompt('cancel')}>Cancel it</button>}
            </div>
          )}

          {canDispatch && !prompt && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Record how it is travelling. The gate pass <span className="mono">{rtv.gate_pass_no}</span>{' '}
                is what lets it leave the premises.
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" className="btn btn-primary" onClick={() => setPrompt('dispatch')}>Dispatch</button>
                {canCancel && <button type="button" className="btn" onClick={() => setPrompt('cancel')}>Cancel it</button>}
              </div>
            </>
          )}

          {canAcknowledge && !prompt && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Record the vendor&rsquo;s own reference — it is what a credit note or a replacement gets
                chased against.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setPrompt('acknowledge')}>
                Record the acknowledgement
              </button>
            </>
          )}

          {canClose && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Close it once the {rtv.basis === 'CREDIT' ? 'credit note has landed' : 'replacement has been received'}.
                Nothing checks that for you yet — this is a deliberate act, not a derived one.
              </p>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'close' })}>
                {act.busy ? 'Closing…' : 'Close the return'}
              </button>
            </>
          )}

          {prompt === 'dispatch' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({
                  action: 'dispatch',
                  transporter: form.transporter || null,
                  lr_no: form.lrNo || null,
                  eway_bill_no: form.ewayBillNo || null,
                });
              }}
            >
              <div className="grid g3">
                <div className="field">
                  <label htmlFor="rtv-transporter">Transporter</label>
                  <input id="rtv-transporter" className="inp" value={form.transporter} onChange={e => setForm(f => ({ ...f, transporter: e.target.value }))} maxLength={120} />
                </div>
                <div className="field">
                  <label htmlFor="rtv-lr">LR number</label>
                  <input id="rtv-lr" className="inp" value={form.lrNo} onChange={e => setForm(f => ({ ...f, lrNo: e.target.value }))} maxLength={80} />
                </div>
                <div className="field">
                  <label htmlFor="rtv-eway">E-way bill</label>
                  <input id="rtv-eway" className="inp" value={form.ewayBillNo} onChange={e => setForm(f => ({ ...f, ewayBillNo: e.target.value }))} maxLength={80} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy}>
                  {act.busy ? 'Dispatching…' : 'Confirm dispatch'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {prompt === 'acknowledge' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'acknowledge', vendor_rma_no: form.rma });
              }}
            >
              <div className="field">
                <label htmlFor="rtv-rma">Vendor RMA or reference</label>
                <input
                  id="rtv-rma"
                  className="inp"
                  value={form.rma}
                  onChange={e => setForm(f => ({ ...f, rma: e.target.value }))}
                  required
                  maxLength={80}
                  placeholder="RMA-2026-0471"
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || !form.rma.trim()}>
                  {act.busy ? 'Recording…' : 'Record it'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {prompt === 'cancel' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'cancel', reason: form.reason });
              }}
            >
              {rtv.status === 'RTV_APPROVED' && reverses && (
                <Banner kind="warn">
                  This return already took the stock out of damaged hold. Cancelling puts it back there —
                  it does not vanish.
                </Banner>
              )}
              <div className="field">
                <label htmlFor="rtv-cancel">Why is this being cancelled?</label>
                <textarea
                  id="rtv-cancel"
                  className="inp"
                  rows={2}
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  required
                  minLength={4}
                  maxLength={500}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || form.reason.trim().length < 4}>
                  {act.busy ? 'Cancelling…' : 'Confirm cancellation'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Keep it</button>
              </div>
            </form>
          )}

          {rtv.status === 'RTV_CLOSED' && (
            <Banner kind="ok">
              Closed{rtv.closed_at ? ` on ${fmtDateTime(rtv.closed_at)}` : ''}. The vendor acknowledged it
              as {rtv.vendor_rma_no}.
            </Banner>
          )}
        </div>
      </Card>
    </>
  );
}
