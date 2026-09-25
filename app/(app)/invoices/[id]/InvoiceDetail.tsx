'use client';

/**
 * An invoice, and the three-way match that decides whether it gets paid.
 *
 * The match is order, receipt, invoice. The received column counts only
 * APPROVED and CLOSED goods receipts, so material sitting in the receiving bay
 * or on an unapproved GRN is not something a vendor can be paid for — and the
 * screen says that rather than showing a difference with no explanation.
 *
 * Debit notes already raised against the order are shown beside the difference,
 * because together they are usually the whole story.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDate, fmtMoney, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { Documents } from '@/components/Documents';

interface Row { [k: string]: unknown }

interface InvoiceView {
  invoice: Row & {
    id: number; invoice_no: string; invoice_date: string; status: string;
    vendor_name: string; vendor_gstin: string | null; vendor_state: string;
    po_no: string; po_id: number; site_name: string; site_state: string;
    place_of_supply: string; taxable_value: string;
    cgst: string; sgst: string; igst: string; total: string;
    held_amount: string; payable: string; bill_control_ref: string | null;
  };
  match: {
    lines: {
      itemCode: string; itemName: string; uom: string;
      qtyOrdered: string; qtyReceived: string; rate: string; receivedValue: string;
    }[];
    receivedTaxable: string;
    invoiceTaxable: string;
    difference: string;
    matches: boolean;
    heldAmount: string;
    debitNotes: (Row & { dn_no: string; total: string; status: string })[];
  };
}

const COLS = '1fr 110px 110px 120px 130px';

export function InvoiceDetail({ id, granted }: { id: number; granted: string[] }) {
  const { data, loading, error, reload } = useResource<InvoiceView>(`/api/invoices/${id}`);
  const [prompt, setPrompt] = useState<'hold' | 'dispute' | 'pay' | null>(null);
  const [form, setForm] = useState({ held: '', remarks: '', reference: '' });

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/invoices/${id}/transition`, body),
    { onDone: () => { setPrompt(null); setForm({ held: '', remarks: '', reference: '' }); reload(); } },
  );

  if (loading) return <LoadingState rows={8} label="Loading the invoice" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { invoice, match } = data;
  const interState = Number(invoice.igst) > 0;
  const overBilled = Number(match.difference) > 0.01;

  const canMatch = invoice.status === 'INV_RECEIVED' && granted.includes('INVOICE.MATCH');
  const canHold = invoice.status === 'INV_MATCHED' && granted.includes('INVOICE.HOLD');
  const canRelease =
    ['INV_MATCHED', 'INV_PARTIALLY_HELD'].includes(invoice.status) && granted.includes('INVOICE.RELEASE');
  const canDispute =
    ['INV_RECEIVED', 'INV_MATCHED', 'INV_PARTIALLY_HELD'].includes(invoice.status) &&
    granted.includes('INVOICE.DISPUTE');
  const canPay = invoice.status === 'INV_RELEASED' && granted.includes('INVOICE.PAY');

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{invoice.invoice_no}</span> <StatusChip status={invoice.status} />
            </h2>
            <span className="sub">
              {invoice.vendor_name} · dated {fmtDate(invoice.invoice_date)} · against{' '}
              <Link href={`/po/${invoice.po_id}`} className="mono">{invoice.po_no}</Link> · {invoice.site_name}
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile label="Taxable" value={`₹${fmtMoney(invoice.taxable_value)}`} />
          <Tile
            label={interState ? 'IGST' : 'CGST + SGST'}
            value={`₹${fmtMoney(interState ? invoice.igst : Number(invoice.cgst) + Number(invoice.sgst))}`}
            hint={interState
              ? `Inter-state: place ${invoice.place_of_supply} into ${invoice.site_state}`
              : `Intra-state: both in ${invoice.site_state}`}
          />
          <Tile label="Total" value={`₹${fmtMoney(invoice.total)}`} hint={invoice.bill_control_ref ?? undefined} />
          <Tile
            label="Payable"
            value={`₹${fmtMoney(invoice.payable)}`}
            hint={Number(invoice.held_amount) > 0 ? `₹${fmtMoney(invoice.held_amount)} withheld` : 'Nothing withheld'}
          />
        </div>
      </Card>

      <Card
        title="Three-way match"
        subtitle="Order, approved receipts, invoice. Only approved goods receipts count towards what a vendor can be paid for."
        label="Three-way match"
      >
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <div>Item</div>
            <div className="r">Ordered</div>
            <div className="r">Received</div>
            <div className="r">Rate</div>
            <div className="r">Received value</div>
          </div>
          {match.lines.map(l => (
            <div key={l.itemCode} className="tr" style={{ gridTemplateColumns: COLS }}>
              <div>
                <span className="mono">{l.itemCode}</span>
                <div className="sub">{l.itemName}</div>
              </div>
              <div className="r">{fmtQty(l.qtyOrdered)} <span className="sub">{l.uom}</span></div>
              <div className="r">
                {fmtQty(l.qtyReceived)}
                {Number(l.qtyReceived) < Number(l.qtyOrdered) && (
                  <div className="sub">short {fmtQty(Number(l.qtyOrdered) - Number(l.qtyReceived))}</div>
                )}
              </div>
              <div className="r">₹{fmtMoney(l.rate)}</div>
              <div className="r">₹{fmtMoney(l.receivedValue)}</div>
            </div>
          ))}
        </div>

        <div className="pad grid g3">
          <Tile label="Received at order rates" value={`₹${fmtMoney(match.receivedTaxable)}`} />
          <Tile label="Billed" value={`₹${fmtMoney(match.invoiceTaxable)}`} />
          <Tile
            label="Difference"
            value={match.matches ? 'None' : `₹${fmtMoney(match.difference)}`}
            hint={match.matches ? 'The bill agrees with the goods' : overBilled ? 'Billed above the goods' : 'Billed below the goods'}
          />
        </div>

        {match.debitNotes.length > 0 && (
          <div className="pad" style={{ paddingTop: 0 }}>
            <span className="lbl">Already debited back</span>
            <div className="tbl" style={{ marginTop: 6 }}>
              {match.debitNotes.map(d => (
                <div key={String(d.dn_no)} className="tr" style={{ gridTemplateColumns: '180px 1fr 140px' }}>
                  <div className="mono">{d.dn_no}</div>
                  <div><StatusChip status={String(d.status)} /></div>
                  <div className="r">₹{fmtMoney(d.total)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Documents
        entityType="INVOICE"
        entityId={invoice.id}
        offered={['INVOICE', 'EWAY_BILL', 'OTHER']}
        canAttach={invoice.status !== 'INV_PAID'}
      />

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {invoice.status === 'INV_RECEIVED' && overBilled && (
            <Banner kind="bad">
              This bills ₹{fmtMoney(match.difference)} more than was received and approved, and only ₹
              {fmtMoney(match.heldAmount)} has been debited back. Raise a debit note for the balance, or
              dispute the invoice — it cannot be matched as it stands.
            </Banner>
          )}

          {canMatch && !prompt && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'match' })}>
                {act.busy ? 'Matching…' : 'Accept the match'}
              </button>
              {canDispute && <button type="button" className="btn" onClick={() => setPrompt('dispute')}>Dispute it</button>}
            </div>
          )}

          {(canHold || canRelease) && !prompt && (
            <div style={{ display: 'flex', gap: 10 }}>
              {canRelease && (
                <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'release' })}>
                  {act.busy ? 'Releasing…' : 'Release for payment'}
                </button>
              )}
              {canHold && <button type="button" className="btn" onClick={() => setPrompt('hold')}>Hold part of it</button>}
              {canDispute && <button type="button" className="btn" onClick={() => setPrompt('dispute')}>Dispute it</button>}
            </div>
          )}

          {canPay && !prompt && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Paying records ₹{fmtMoney(invoice.payable)} against the vendor ledger — the invoice less
                anything withheld.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setPrompt('pay')}>Record payment</button>
            </>
          )}

          {prompt === 'hold' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'hold', held_amount: form.held, remarks: form.remarks });
              }}
            >
              <div className="grid g2">
                <div className="field">
                  <label htmlFor="inv-held">How much to hold (₹)</label>
                  <input id="inv-held" className="inp" inputMode="decimal" value={form.held} onChange={e => setForm(f => ({ ...f, held: e.target.value }))} required />
                  <span className="sub">Of ₹{fmtMoney(invoice.total)}</span>
                </div>
                <div className="field">
                  <label htmlFor="inv-hold-why">Why</label>
                  <input id="inv-hold-why" className="inp" value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} required minLength={4} maxLength={500} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || !form.held || form.remarks.trim().length < 4}>
                  {act.busy ? 'Holding…' : 'Hold it'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {prompt === 'dispute' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'dispute', remarks: form.remarks });
              }}
            >
              <div className="field">
                <label htmlFor="inv-dispute">What is wrong with it?</label>
                <textarea id="inv-dispute" className="inp" rows={2} value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} required minLength={4} maxLength={500} />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || form.remarks.trim().length < 4}>
                  {act.busy ? 'Disputing…' : 'Dispute it'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
              <p className="sub" style={{ marginBottom: 0 }}>
                A dispute flags the invoice; it does not un-book it. The payable still stands until it is
                settled or the invoice is cancelled.
              </p>
            </form>
          )}

          {prompt === 'pay' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'pay', reference: form.reference });
              }}
            >
              <div className="field">
                <label htmlFor="inv-ref">Payment reference</label>
                <input id="inv-ref" className="inp" value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} required maxLength={120} placeholder="NEFT/2026/09/8812" />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || !form.reference.trim()}>
                  {act.busy ? 'Recording…' : `Record ₹${fmtMoney(invoice.payable)} paid`}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {invoice.status === 'INV_PAID' && (
            <Banner kind="ok">
              Paid. {Number(invoice.held_amount) > 0 && `₹${fmtMoney(invoice.held_amount)} was withheld and is still owed.`}
            </Banner>
          )}
        </div>
      </Card>
    </>
  );
}
