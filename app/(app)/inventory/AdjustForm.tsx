'use client';

/**
 * Reconcile the system to a physical count.
 *
 * The form asks what was COUNTED, never for a difference. A difference invites
 * the wrong sign, and a resubmitted difference double-counts; the movement is
 * worked out from the gap. A count that agrees posts nothing at all, and the
 * form says so before it is submitted.
 *
 * Every stock take that found a discrepancy is a record in its own right
 * (conflict C-27), numbered and append-only — so "why is the figure different
 * from last month" has an answer that does not depend on the audit log.
 */
import { useState } from 'react';
import { Banner, Card, FieldError, fmtQty } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation } from '@/lib/client/use-resource';

interface Item {
  item_id: number;
  code: string;
  name: string;
  uom: string;
  available: string;
}

export function AdjustForm({
  siteId,
  item,
  onClose,
  onDone,
}: {
  siteId: number;
  item: Item;
  onClose: () => void;
  onDone: () => void;
}) {
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');

  const adjust = useMutation(
    async () =>
      api.post('/api/inventory/adjust', {
        site_id: siteId,
        item_id: item.item_id,
        counted_qty: counted,
        reason,
      }),
    { onDone, successMessage: 'Stock take recorded.' },
  );

  const onSystem = Number(item.available);
  const delta = counted === '' ? null : Number(counted) - onSystem;
  const err = (field: string) => (adjust.fieldError?.field === field ? adjust.fieldError.message : null);

  return (
    <Card
      title={`Stock take — ${item.code}`}
      subtitle={item.name}
      label="Stock take"
      right={<button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>}
    >
      <form
        className="pad"
        onSubmit={e => {
          e.preventDefault();
          void adjust.run(undefined);
        }}
      >
        {adjust.error && <Banner kind="bad">{adjust.error}</Banner>}

        <div className="grid g3">
          <div className="field">
            <span className="lbl">System says</span>
            <div style={{ paddingTop: 8, fontSize: 18 }}>
              <strong>{fmtQty(onSystem)}</strong> <span className="sub">{item.uom}</span>
            </div>
          </div>

          <div className="field">
            <label htmlFor="adj-counted">You counted</label>
            <input
              id="adj-counted"
              className="inp"
              inputMode="decimal"
              value={counted}
              onChange={e => setCounted(e.target.value)}
              required
              autoFocus
            />
            {err('counted_qty') && <FieldError id="adj-counted">{err('counted_qty')}</FieldError>}
          </div>

          <div className="field">
            <span className="lbl">Difference</span>
            <div style={{ paddingTop: 8 }}>
              {delta === null ? (
                <span className="sub">—</span>
              ) : delta === 0 ? (
                <span className="chip ok">matches</span>
              ) : (
                <span className={delta < 0 ? 'chip bad' : 'chip warn'}>
                  {delta > 0 ? '+' : ''}{fmtQty(delta)} {item.uom}
                </span>
              )}
            </div>
          </div>
        </div>

        {delta === 0 && (
          <Banner kind="ok">
            The count agrees with the system, so nothing will be posted. There is no discrepancy to record.
          </Banner>
        )}

        <div className="field">
          <label htmlFor="adj-reason">What did you find?</label>
          <textarea
            id="adj-reason"
            className="inp"
            rows={2}
            value={reason}
            onChange={e => setReason(e.target.value)}
            required
            minLength={4}
            maxLength={500}
            placeholder="Where you counted, and anything that explains the difference."
          />
          {err('reason') && <FieldError id="adj-reason">{err('reason')}</FieldError>}
        </div>

        <p className="sub">
          This corrects the system to match reality. If instead a movement was posted wrongly, reverse that
          movement from the ledger — an adjustment would hide the mistake rather than correct it.
        </p>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={adjust.busy || counted === '' || reason.trim().length < 4}
          >
            {adjust.busy ? 'Recording…' : delta === 0 ? 'Confirm the count' : 'Record the stock take'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
