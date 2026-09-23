'use client';

/**
 * Book a vendor invoice.
 *
 * The GST mode is not a dropdown. Once an order is chosen, its site's state is
 * known; once the place of supply is entered, whether the supply crossed a
 * state line is known too — and that decides whether the tax is CGST plus SGST
 * or IGST. So the form shows which applies and only asks for those fields.
 *
 * The server derives the same thing and refuses a mismatch, because getting it
 * wrong misstates the input tax credit and neither the vendor nor the typist is
 * the right authority on it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Banner, Card, FieldError, fmtMoney } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface AwaitingPo {
  id: number;
  po_no: string;
  vendor_name: string;
  site_name: string;
  site_state: string;
  vendor_state: string;
  received_value: string;
}

export function NewInvoiceForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const awaiting = useResource<AwaitingPo[]>('/api/invoices/awaiting');

  const [poId, setPoId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [taxable, setTaxable] = useState('');
  const [cgst, setCgst] = useState('');
  const [igst, setIgst] = useState('');
  const [billControlRef, setBillControlRef] = useState('');

  const po = useMemo(
    () => (awaiting.data ?? []).find(p => String(p.id) === poId) ?? null,
    [awaiting.data, poId],
  );

  // The vendor's own state is the usual place of supply, so it is offered —
  // but it is editable, because a vendor may supply from another state.
  useEffect(() => {
    if (po && !placeOfSupply) setPlaceOfSupply(po.vendor_state);
  }, [po, placeOfSupply]);

  const interState = po !== null && placeOfSupply !== '' && placeOfSupply !== po.site_state;

  const create = useMutation(
    async () =>
      api.post('/api/invoices', {
        po_id: Number(poId),
        invoice_no: invoiceNo,
        invoice_date: invoiceDate,
        place_of_supply: placeOfSupply,
        taxable_value: taxable,
        cgst: interState ? '0' : cgst || '0',
        sgst: interState ? '0' : cgst || '0',
        igst: interState ? igst || '0' : '0',
        bill_control_ref: billControlRef || null,
      }),
    { onDone: onCreated, successMessage: 'Invoice booked.' },
  );

  const err = (field: string) => (create.fieldError?.field === field ? create.fieldError.message : null);

  const total =
    Number(taxable || 0) + (interState ? Number(igst || 0) : Number(cgst || 0) * 2);

  const ready = poId !== '' && invoiceNo.trim() !== '' && placeOfSupply !== '' && Number(taxable) > 0;

  return (
    <Card
      title="Book a vendor invoice"
      label="Book an invoice"
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

        <div className="grid g3">
          <div className="field">
            <label htmlFor="inv-po">Against which order?</label>
            <select id="inv-po" className="inp" value={poId} onChange={e => { setPoId(e.target.value); setPlaceOfSupply(''); }} required>
              <option value="">Choose an order…</option>
              {(awaiting.data ?? []).map(p => (
                <option key={p.id} value={p.id}>
                  {p.po_no} — {p.vendor_name}
                </option>
              ))}
            </select>
            {awaiting.data?.length === 0 && (
              <span className="sub">
                No order has received goods yet. An invoice is booked against what actually arrived.
              </span>
            )}
            {err('po_id') && <FieldError id="inv-po">{err('po_id')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="inv-no">Invoice number</label>
            <input id="inv-no" className="inp mono" value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} required maxLength={80} />
            {err('invoice_no') && <FieldError id="inv-no">{err('invoice_no')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="inv-date">Invoice date</label>
            <input id="inv-date" className="inp" type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} required />
          </div>
        </div>

        {po && (
          <div className="grid g4">
            <div className="field">
              <label htmlFor="inv-pos">Place of supply</label>
              <input
                id="inv-pos"
                className="inp mono"
                value={placeOfSupply}
                onChange={e => setPlaceOfSupply(e.target.value)}
                required
                maxLength={2}
              />
              <span className="sub">{po.site_name} is in state {po.site_state}</span>
              {err('place_of_supply') && <FieldError id="inv-pos">{err('place_of_supply')}</FieldError>}
            </div>

            <div className="field">
              <label htmlFor="inv-taxable">Taxable value (₹)</label>
              <input id="inv-taxable" className="inp" inputMode="decimal" value={taxable} onChange={e => setTaxable(e.target.value)} required />
              <span className="sub">₹{fmtMoney(po.received_value)} received at order rates</span>
              {err('taxable_value') && <FieldError id="inv-taxable">{err('taxable_value')}</FieldError>}
            </div>

            {interState ? (
              <div className="field">
                <label htmlFor="inv-igst">IGST (₹)</label>
                <input id="inv-igst" className="inp" inputMode="decimal" value={igst} onChange={e => setIgst(e.target.value)} />
                <span className="sub">Inter-state supply</span>
                {err('igst') && <FieldError id="inv-igst">{err('igst')}</FieldError>}
              </div>
            ) : (
              <div className="field">
                <label htmlFor="inv-cgst">CGST and SGST, each (₹)</label>
                <input id="inv-cgst" className="inp" inputMode="decimal" value={cgst} onChange={e => setCgst(e.target.value)} />
                <span className="sub">Intra-state; both halves are always equal</span>
                {err('cgst') && <FieldError id="inv-cgst">{err('cgst')}</FieldError>}
              </div>
            )}

            <div className="field">
              <label htmlFor="inv-bcr">Bill control reference</label>
              <input id="inv-bcr" className="inp" value={billControlRef} onChange={e => setBillControlRef(e.target.value)} maxLength={80} />
            </div>
          </div>
        )}

        {po && (
          <Banner kind="info">
            {interState
              ? `Place of supply ${placeOfSupply} against ${po.site_name} in state ${po.site_state} — this crossed a state line, so it carries IGST.`
              : `Place of supply ${placeOfSupply} and ${po.site_name} are both in state ${po.site_state} — this is intra-state, so it carries CGST and SGST.`}
            {total > 0 && <> Invoice total ₹{fmtMoney(total)}.</>}
          </Banner>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={create.busy || !ready}>
            {create.busy ? 'Booking…' : 'Book the invoice'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
