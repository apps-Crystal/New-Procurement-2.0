'use client';

/**
 * Record what a vendor quoted.
 *
 * Every PR line must be quoted — a quotation missing a line is refused, because
 * a comparison between a complete quote and a partial one is not a comparison.
 * Only approved vendors appear: `check_po_vendor()` would refuse the order
 * later anyway, and finding that out at the PO stage wastes everyone's time.
 */
import { useState } from 'react';
import { Banner, FieldError, fmtQty } from '@/components/ui';
import { api, qs } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import type { PrLine } from '@/app/(app)/pr/[id]/QuotationPanel';

interface Vendor {
  id: number;
  vendor_code: string;
  legal_name: string;
}

export function NewQuotationForm({
  prId,
  lines,
  onClose,
  onSaved,
}: {
  prId: number;
  lines: PrLine[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const vendors = useResource<Vendor[]>(`/api/vendors${qs({ status: 'VENDOR_APPROVED' })}`);

  const [vendorId, setVendorId] = useState('');
  const [quoteRef, setQuoteRef] = useState('');
  const [quoteDate, setQuoteDate] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [freight, setFreight] = useState('0');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [warranty, setWarranty] = useState('');
  const [rates, setRates] = useState<Record<number, { rate: string; gst: string; lead: string; make: string }>>({});

  const save = useMutation(
    async () =>
      api.post('/api/quotations', {
        pr_id: prId,
        vendor_id: Number(vendorId),
        vendor_quote_ref: quoteRef,
        quote_date: quoteDate,
        valid_until: validUntil,
        freight_amount: freight || '0',
        payment_terms: paymentTerms || null,
        warranty_months: warranty ? Number(warranty) : null,
        lines: lines.map(l => ({
          pr_line_id: l.id,
          unit_rate: rates[l.id]?.rate ?? '',
          gst_rate: rates[l.id]?.gst ?? l.gst_rate,
          lead_time_days: rates[l.id]?.lead ? Number(rates[l.id].lead) : null,
          make: rates[l.id]?.make || null,
        })),
      }),
    { onDone: onSaved, successMessage: 'Quotation recorded.' },
  );

  const err = (field: string) => (save.fieldError?.field === field ? save.fieldError.message : null);
  const incomplete = lines.some(l => !rates[l.id]?.rate);

  return (
    <form
      className="pad"
      style={{ borderTop: '1px solid var(--line-2)' }}
      onSubmit={e => {
        e.preventDefault();
        void save.run(undefined);
      }}
    >
      {save.error && <Banner kind="bad">{save.error}</Banner>}

      <div className="grid g4">
        <div className="field">
          <label htmlFor="q-vendor">Vendor</label>
          <select id="q-vendor" className="inp" value={vendorId} onChange={e => setVendorId(e.target.value)} required>
            <option value="">Choose an approved vendor…</option>
            {(vendors.data ?? []).map(v => (
              <option key={v.id} value={v.id}>{v.legal_name}</option>
            ))}
          </select>
          {err('vendor_id') && <FieldError id="q-vendor">{err('vendor_id')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="q-ref">Their quote reference</label>
          <input id="q-ref" className="inp" value={quoteRef} onChange={e => setQuoteRef(e.target.value)} required maxLength={80} />
          {err('vendor_quote_ref') && <FieldError id="q-ref">{err('vendor_quote_ref')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="q-date">Quoted on</label>
          <input id="q-date" className="inp" type="date" value={quoteDate} onChange={e => setQuoteDate(e.target.value)} required />
        </div>

        <div className="field">
          <label htmlFor="q-valid">Valid until</label>
          <input id="q-valid" className="inp" type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} required />
          {err('valid_until') && <FieldError id="q-valid">{err('valid_until')}</FieldError>}
        </div>
      </div>

      <div className="grid g3">
        <div className="field">
          <label htmlFor="q-freight">Freight (₹)</label>
          <input id="q-freight" className="inp" inputMode="decimal" value={freight} onChange={e => setFreight(e.target.value)} />
          <span className="sub">Counted in the landed cost, so a low rate with high freight ranks honestly.</span>
        </div>
        <div className="field">
          <label htmlFor="q-terms">Payment terms</label>
          <input id="q-terms" className="inp" value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)} maxLength={500} placeholder="e.g. 30 days from delivery" />
        </div>
        <div className="field">
          <label htmlFor="q-warranty">Warranty (months)</label>
          <input id="q-warranty" className="inp" inputMode="numeric" value={warranty} onChange={e => setWarranty(e.target.value)} />
        </div>
      </div>

      <h4 style={{ margin: '18px 0 8px' }}>Rates, for every line</h4>

      <div className="tbl">
        <div className="tr th" style={{ gridTemplateColumns: '1fr 110px 120px 90px 110px 1fr' }}>
          <div>Item</div>
          <div className="r">Quantity</div>
          <div className="r">Unit rate</div>
          <div className="r">GST %</div>
          <div className="r">Lead days</div>
          <div>Make</div>
        </div>
        {lines.map(l => {
          const row = rates[l.id] ?? { rate: '', gst: l.gst_rate, lead: '', make: '' };
          const patch = (p: Partial<typeof row>) => setRates(r => ({ ...r, [l.id]: { ...row, ...p } }));

          return (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: '1fr 110px 120px 90px 110px 1fr' }}>
              <div>
                <span className="mono">{l.item_code}</span>
                <div className="sub">{l.item_name}</div>
              </div>
              <div className="r">{fmtQty(l.qty)} <span className="sub">{l.uom}</span></div>
              <div className="r">
                <label htmlFor={`q-rate-${l.id}`} className="sr-only">Unit rate for {l.item_code}</label>
                <input
                  id={`q-rate-${l.id}`}
                  className="inp-sm"
                  inputMode="decimal"
                  value={row.rate}
                  onChange={e => patch({ rate: e.target.value })}
                  required
                />
              </div>
              <div className="r">
                <label htmlFor={`q-gst-${l.id}`} className="sr-only">GST rate for {l.item_code}</label>
                <input
                  id={`q-gst-${l.id}`}
                  className="inp-sm"
                  inputMode="decimal"
                  value={row.gst}
                  onChange={e => patch({ gst: e.target.value })}
                />
              </div>
              <div className="r">
                <label htmlFor={`q-lead-${l.id}`} className="sr-only">Lead time for {l.item_code}</label>
                <input
                  id={`q-lead-${l.id}`}
                  className="inp-sm"
                  inputMode="numeric"
                  value={row.lead}
                  onChange={e => patch({ lead: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`q-make-${l.id}`} className="sr-only">Make offered for {l.item_code}</label>
                <input
                  id={`q-make-${l.id}`}
                  className="inp"
                  value={row.make}
                  onChange={e => patch({ make: e.target.value })}
                  placeholder="Make offered"
                  maxLength={120}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button type="submit" className="btn btn-primary" disabled={save.busy || incomplete}>
          {save.busy ? 'Saving…' : 'Record quotation'}
        </button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        {incomplete && <span className="sub" style={{ alignSelf: 'center' }}>Every line needs a rate.</span>}
      </div>
    </form>
  );
}
