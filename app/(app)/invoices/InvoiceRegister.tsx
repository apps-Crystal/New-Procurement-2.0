'use client';

/**
 * Vendor invoices.
 *
 * The payable column is the invoice less whatever is being withheld, because
 * that is the figure anybody actually acts on. The gross total is there too —
 * a held amount that is invisible is a held amount somebody pays by accident.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtMoney,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { NewInvoiceForm } from '@/app/(app)/invoices/NewInvoiceForm';

interface Invoice {
  id: number;
  invoice_no: string;
  invoice_date: string;
  status: string;
  vendor_name: string;
  po_no: string;
  site_name: string;
  place_of_supply: string;
  taxable_value: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  held_amount: string;
  payable: string;
}

const COLS = '160px 1fr 120px 140px 140px 150px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Received', value: 'INV_RECEIVED' },
  { label: 'Matched', value: 'INV_MATCHED' },
  { label: 'Held', value: 'INV_PARTIALLY_HELD' },
  { label: 'Disputed', value: 'INV_DISPUTED' },
  { label: 'Paid', value: 'INV_PAID' },
];

export function InvoiceRegister({ granted }: { granted: string[] }) {
  const [status, setStatus] = useState('');
  const [booking, setBooking] = useState(false);

  const url = `/api/invoices${qs({ status })}`;
  const { data, loading, error, reload } = useResource<Invoice[]>(url, [status]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    const open = rows.filter(i => i.status !== 'INV_PAID');
    return {
      total: rows.length,
      toMatch: rows.filter(i => i.status === 'INV_RECEIVED').length,
      disputed: rows.filter(i => i.status === 'INV_DISPUTED').length,
      payable: open.reduce((s, i) => s + Number(i.payable ?? 0), 0),
      held: rows.reduce((s, i) => s + Number(i.held_amount ?? 0), 0),
    };
  }, [data]);

  const canBook = granted.includes('INVOICE.CREATE');

  return (
    <>
      <Kpis>
        <Kpi label="Invoices" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Awaiting match" value={counts.toMatch} hint="Not yet checked against receipts" tone={counts.toMatch ? 'warn' : undefined} />
        <Kpi label="Open payable" value={`₹${fmtMoney(counts.payable)}`} hint="Net of anything held" />
        <Kpi label="Withheld" value={`₹${fmtMoney(counts.held)}`} hint="Against returns and shortfalls" tone={counts.held ? 'info' : undefined} />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field">
          <span className="lbl">Stage</span>
          <div className="seg" role="radiogroup" aria-label="Stage">
            {FILTERS.map(f => (
              <button
                key={f.value}
                type="button"
                className="btn btn-sm"
                role="radio"
                aria-checked={status === f.value}
                onClick={() => setStatus(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {canBook && !booking && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setBooking(true)}>
            Book an invoice
          </button>
        )}
      </section>

      {booking && (
        <NewInvoiceForm
          onClose={() => setBooking(false)}
          onCreated={() => {
            setBooking(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading invoices" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status ? 'Nothing matches that' : 'No invoices booked'}
          action={
            status ? (
              <button type="button" className="btn" onClick={() => setStatus('')}>Clear filter</button>
            ) : canBook ? (
              <button type="button" className="btn btn-primary" onClick={() => setBooking(true)}>Book an invoice</button>
            ) : null
          }
        >
          An invoice is booked against a purchase order that has received goods, then checked against what
          actually arrived before anything is paid.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Vendor invoices">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Invoice</div>
              <div>Vendor and order</div>
              <div>Tax</div>
              <div className="r">Total</div>
              <div className="r">Payable</div>
              <div>Stage</div>
            </div>
            {(data ?? []).map(i => (
              <Link key={i.id} href={`/invoices/${i.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">
                  {i.invoice_no}
                  <div className="sub">{fmtDate(i.invoice_date)}</div>
                </div>
                <div>
                  {i.vendor_name}
                  <div className="sub">
                    <span className="mono">{i.po_no}</span> · {i.site_name}
                  </div>
                </div>
                <div className="sub">
                  {Number(i.igst) > 0 ? `IGST ₹${fmtMoney(i.igst)}` : `CGST+SGST ₹${fmtMoney(Number(i.cgst) + Number(i.sgst))}`}
                  <div>place {i.place_of_supply}</div>
                </div>
                <div className="r">₹{fmtMoney(i.total)}</div>
                <div className="r">
                  <strong>₹{fmtMoney(i.payable)}</strong>
                  {Number(i.held_amount) > 0 && (
                    <div className="sub">₹{fmtMoney(i.held_amount)} held</div>
                  )}
                </div>
                <div><StatusChip status={i.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
