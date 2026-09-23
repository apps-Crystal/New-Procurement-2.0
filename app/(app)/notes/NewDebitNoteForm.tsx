'use client';

/**
 * Raise a debit note.
 *
 * The value comes from the origin and is shown before it is accepted. Accounts
 * may override it — a settlement is a negotiation — but the override carries a
 * remark, because the difference between what was owed and what was claimed is
 * exactly the thing somebody will ask about later.
 *
 * The quantity is never editable. That is a physical fact somebody already
 * recorded at the gate or on the return.
 */
import { useMemo, useState } from 'react';
import { Banner, Card, FieldError, fmtMoney } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Origin {
  kind: string;
  source_id: number;
  reference: string;
  site_name: string;
  vendor_name: string;
  po_no: string;
  po_id: number;
  taxable: string;
}

interface Invoice {
  id: number;
  invoice_no: string;
  po_id: number;
  taxable_value: string;
  cgst: string;
  sgst: string;
  igst: string;
}

export function NewDebitNoteForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const origins = useResource<Origin[]>('/api/debit-notes/origins');
  const invoices = useResource<Invoice[]>('/api/invoices');

  const [key, setKey] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [override, setOverride] = useState('');
  const [overrideRemark, setOverrideRemark] = useState('');

  const chosen = useMemo(
    () => (origins.data ?? []).find(o => `${o.kind}:${o.source_id}` === key) ?? null,
    [origins.data, key],
  );

  // Only invoices against the same order can have their tax mirrored.
  const eligible = useMemo(
    () => (invoices.data ?? []).filter(i => chosen !== null && Number(i.po_id) === chosen.po_id),
    [invoices.data, chosen],
  );

  const create = useMutation(
    async () => {
      if (!chosen) return;
      return api.post('/api/debit-notes', {
        rtv_id: chosen.kind === 'RTV' ? chosen.source_id : null,
        shortfall_id: chosen.kind === 'SHORTFALL' ? chosen.source_id : null,
        vendor_invoice_id: invoiceId ? Number(invoiceId) : null,
        value_override: override || null,
        value_override_remark: overrideRemark || null,
      });
    },
    { onDone: onCreated, successMessage: 'Debit note raised.' },
  );

  const err = (field: string) => (create.fieldError?.field === field ? create.fieldError.message : null);
  const overriding = override.trim() !== '' && Number(override) !== Number(chosen?.taxable ?? 0);

  return (
    <Card
      title="Raise a debit note"
      label="Raise a debit note"
      right={<button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>}
    >
      <form
        className="pad"
        onSubmit={e => {
          e.preventDefault();
          void create.run(undefined);
        }}
      >
        {create.error && <Banner kind="bad">{create.error}</Banner>}

        <div className="grid g2">
          <div className="field">
            <label htmlFor="dn-origin">What is being debited?</label>
            <select id="dn-origin" className="inp" value={key} onChange={e => { setKey(e.target.value); setInvoiceId(''); setOverride(''); }} required>
              <option value="">Choose an origin…</option>
              {(origins.data ?? []).map(o => (
                <option key={`${o.kind}:${o.source_id}`} value={`${o.kind}:${o.source_id}`}>
                  {o.reference} — {o.kind === 'RTV' ? 'return' : 'shortfall'} — {o.vendor_name}
                </option>
              ))}
            </select>
            {origins.data?.length === 0 && (
              <span className="sub">
                Nothing is waiting. Returns appear once dispatched, shortfalls once short-closed — until
                then the vendor owes goods, not money.
              </span>
            )}
            {err('source') && <FieldError id="dn-origin">{err('source')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="dn-invoice">Mirror the tax from which invoice?</label>
            <select id="dn-invoice" className="inp" value={invoiceId} onChange={e => setInvoiceId(e.target.value)} disabled={!chosen}>
              <option value="">No invoice — taxable value only</option>
              {eligible.map(i => (
                <option key={i.id} value={i.id}>{i.invoice_no}</option>
              ))}
            </select>
            <span className="sub">
              The credit has to reverse the tax that was actually charged, so it mirrors the invoice rather
              than being recomputed.
            </span>
          </div>
        </div>

        {chosen && (
          <>
            <div className="grid g4" style={{ marginTop: 6 }}>
              <div className="field">
                <span className="lbl">Vendor</span>
                <div style={{ paddingTop: 6 }}>{chosen.vendor_name}</div>
              </div>
              <div className="field">
                <span className="lbl">Against order</span>
                <div className="mono" style={{ paddingTop: 6 }}>{chosen.po_no}</div>
              </div>
              <div className="field">
                <span className="lbl">Value from the origin</span>
                <div style={{ paddingTop: 6 }}>₹{fmtMoney(chosen.taxable)}</div>
              </div>
              <div className="field">
                <label htmlFor="dn-override">Override the value (₹)</label>
                <input
                  id="dn-override"
                  className="inp"
                  inputMode="decimal"
                  value={override}
                  onChange={e => setOverride(e.target.value)}
                  placeholder="Leave blank to use it as it is"
                />
                {err('value_override') && <FieldError id="dn-override">{err('value_override')}</FieldError>}
              </div>
            </div>

            {overriding && (
              <div className="field">
                <label htmlFor="dn-why">Why is the value being changed?</label>
                <input
                  id="dn-why"
                  className="inp"
                  value={overrideRemark}
                  onChange={e => setOverrideRemark(e.target.value)}
                  required
                  minLength={4}
                  maxLength={500}
                  placeholder="Settled at a lower figure with the vendor"
                />
                {err('value_override_remark') && <FieldError id="dn-why">{err('value_override_remark')}</FieldError>}
              </div>
            )}

            <Banner kind="info">
              Raising it does not tell the vendor. The payable moves when the note is issued, which is a
              separate step.
            </Banner>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={create.busy || !chosen || (overriding && overrideRemark.trim().length < 4)}
          >
            {create.busy ? 'Raising…' : 'Raise the debit note'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
