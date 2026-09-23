'use client';

/**
 * Concession or rejection on held stock.
 *
 * A concession takes material that failed inspection, so the reason is not a
 * formality — it is the record of who accepted the risk, and it is written to
 * the audit trail as an OVERRIDE rather than an ordinary update.
 *
 * The inspector who raised the hold cannot decide it. That is enforced in the
 * service; the form simply does not pretend otherwise.
 */
import { useState } from 'react';
import { Banner, fmtQty } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation } from '@/lib/client/use-resource';

export function HoldDecision({
  qcLineId,
  itemCode,
  qtyHold,
  onDone,
}: {
  qcLineId: number;
  itemCode: string;
  qtyHold: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState<'CONCESSION' | 'REJECT' | null>(null);
  const [qty, setQty] = useState(qtyHold);
  const [reason, setReason] = useState('');

  const decide = useMutation(
    async (decision: 'CONCESSION' | 'REJECT') =>
      api.post(`/api/qc/holds/${qcLineId}`, { decision, qty, reason }),
    { onDone: () => { setOpen(null); setReason(''); onDone(); } },
  );

  if (!open) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-sm" onClick={() => setOpen('CONCESSION')}>Concession</button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen('REJECT')}>Reject</button>
      </div>
    );
  }

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        void decide.run(open);
      }}
    >
      {decide.error && <Banner kind="bad">{decide.error}</Banner>}

      <div className="field" style={{ margin: '0 0 6px' }}>
        <label htmlFor={`hd-qty-${qcLineId}`} className="sr-only">Quantity for {itemCode}</label>
        <input
          id={`hd-qty-${qcLineId}`}
          className="inp-sm"
          inputMode="decimal"
          value={qty}
          onChange={e => setQty(e.target.value)}
          required
        />
        <span className="sub"> of {fmtQty(qtyHold)} held</span>
      </div>

      <div className="field" style={{ margin: '0 0 6px' }}>
        <label htmlFor={`hd-why-${qcLineId}`} className="sr-only">
          Reason for the {open.toLowerCase()} on {itemCode}
        </label>
        <input
          id={`hd-why-${qcLineId}`}
          className="inp"
          value={reason}
          onChange={e => setReason(e.target.value)}
          required
          minLength={4}
          maxLength={500}
          placeholder={
            open === 'CONCESSION'
              ? 'Why this is acceptable anyway, and on whose authority'
              : 'Why this goes back to the vendor'
          }
        />
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="btn btn-sm btn-primary" disabled={decide.busy || reason.trim().length < 4}>
          {decide.busy ? 'Saving…' : open === 'CONCESSION' ? 'Take on concession' : 'Send back'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(null)}>Cancel</button>
      </div>
    </form>
  );
}
