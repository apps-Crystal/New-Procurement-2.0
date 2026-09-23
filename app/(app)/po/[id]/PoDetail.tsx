'use client';

/**
 * Purchase order detail, and the issue checklist.
 *
 * The checklist is the interesting part. Rather than disabling the Issue button
 * and leaving the buyer to guess, every gate is listed with its verdict — the
 * award cleared, the vendor still approved, the Tally reference present. The
 * checks are computed server-side in `issueChecks()`, so what is shown here is
 * what will actually be enforced, not a hopeful copy of it.
 *
 * A rate differing from the awarded quote carries a remark
 * (`po_lines.rate_deviation_remark`), shown against the line rather than buried.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDate, fmtMoney, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Row { [k: string]: unknown }

interface Check {
  label: string;
  passed: boolean;
  detail?: string;
}

interface PoView {
  po: Row & {
    id: number; po_no: string; status: string; site_name: string; site_gstin: string | null;
    vendor_name: string; vendor_code: string; vendor_gstin: string | null; vendor_pan: string;
    pr_id: number; pr_no: string; mr_no: string; budget_code: string; buyer_name: string;
    expected_delivery: string; freight_amount: string; freight_terms: string | null;
    installation_terms: string | null; tally_po_ref: string | null;
    vendor_quote_ref: string | null; payment_terms: string | null; warranty_months: number | null;
    created_at: string;
  };
  lines: (Row & {
    id: number; line_no: number; item_code: string; item_name: string; uom: string;
    qty_ordered: string; rate: string; gst_rate: string;
    line_taxable: string; line_gst: string; line_total: string;
    qty_received: string | null; qty_outstanding: string | null;
    rate_deviation_remark: string | null;
  })[];
  checks: Check[];
}

const COLS = '40px 1fr 110px 110px 70px 120px 120px';

export function PoDetail({ id, granted }: { id: number; granted: string[] }) {
  const { data, loading, error, reload } = useResource<PoView>(`/api/po/${id}`);
  const [tallyRef, setTallyRef] = useState('');

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/po/${id}/transition`, body),
    { onDone: () => { setTallyRef(''); reload(); } },
  );

  if (loading) return <LoadingState rows={8} label="Loading the order" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { po, lines, checks } = data;

  const taxable = lines.reduce((s, l) => s + Number(l.line_taxable), 0);
  const gst = lines.reduce((s, l) => s + Number(l.line_gst), 0);
  const total = taxable + gst + Number(po.freight_amount ?? 0);

  const canIssue = po.status === 'PO_DRAFT' && granted.includes('PO.ISSUE');
  // Every gate except the Tally reference itself, which is being typed now.
  const blocking = checks.filter(c => !c.passed && !/tally/i.test(c.label));

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{po.po_no}</span> <StatusChip status={po.status} />
            </h2>
            <span className="sub">
              {po.vendor_name} · for {po.site_name} · from{' '}
              <Link href={`/pr/${po.pr_id}`} className="mono">{po.pr_no}</Link> · buyer {po.buyer_name}
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile label="Taxable" value={`₹${fmtMoney(taxable)}`} />
          <Tile label="GST" value={`₹${fmtMoney(gst)}`} />
          <Tile label="Freight" value={`₹${fmtMoney(po.freight_amount)}`} hint={po.freight_terms ?? undefined} />
          <Tile label="Total" value={`₹${fmtMoney(total)}`} hint={`Expected ${fmtDate(po.expected_delivery)}`} />
        </div>

        <div className="pad grid g4" style={{ paddingTop: 0 }}>
          <Tile label="Vendor GSTIN" value={po.vendor_gstin ?? 'Unregistered'} hint={`PAN ${po.vendor_pan}`} />
          <Tile label="Site GSTIN" value={po.site_gstin ?? '—'} />
          <Tile label="Against quote" value={po.vendor_quote_ref ?? '—'} hint={po.payment_terms ?? undefined} />
          <Tile
            label="Tally reference"
            value={po.tally_po_ref ?? 'Not issued'}
            hint={po.warranty_months ? `${po.warranty_months} months warranty` : undefined}
          />
        </div>
      </Card>

      <Card title="Ordered" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <div>#</div>
            <div>Item</div>
            <div className="r">Ordered</div>
            <div className="r">Rate</div>
            <div className="r">GST</div>
            <div className="r">Total</div>
            <div className="r">Outstanding</div>
          </div>
          {lines.map(l => (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: COLS }}>
              <div className="sub">{l.line_no}</div>
              <div>
                <span className="mono">{l.item_code}</span>
                <div className="sub">{l.item_name}</div>
                {l.rate_deviation_remark && (
                  <div className="sub"><strong>Rate changed:</strong> {l.rate_deviation_remark}</div>
                )}
              </div>
              <div className="r">{fmtQty(l.qty_ordered)} <span className="sub">{l.uom}</span></div>
              <div className="r">₹{fmtMoney(l.rate)}</div>
              <div className="r sub">{l.gst_rate}%</div>
              <div className="r">₹{fmtMoney(l.line_total)}</div>
              <div className="r">
                {l.qty_outstanding === null ? (
                  fmtQty(l.qty_ordered)
                ) : Number(l.qty_outstanding) === 0 ? (
                  <span className="chip ok">complete</span>
                ) : (
                  fmtQty(l.qty_outstanding)
                )}
              </div>
            </div>
          ))}
        </div>
        {po.installation_terms && (
          <div className="pad sub" style={{ borderTop: '1px solid var(--line-2)' }}>
            <strong>Installation:</strong> {po.installation_terms}
          </div>
        )}
      </Card>

      <Card title="Before this order can be issued" label="Issue checklist">
        <div className="tbl">
          {checks.map(c => (
            <div key={c.label} className="tr" style={{ gridTemplateColumns: '40px 1fr' }}>
              <div>
                <span className={c.passed ? 'chip ok' : 'chip bad'}>{c.passed ? '✓' : '×'}</span>
              </div>
              <div>
                {c.label}
                {c.detail && <div className="sub">{c.detail}</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {canIssue && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'issue', tally_po_ref: tallyRef });
              }}
            >
              <div className="field">
                <label htmlFor="po-tally">Tally purchase order reference</label>
                <input
                  id="po-tally"
                  className="inp"
                  value={tallyRef}
                  onChange={e => setTallyRef(e.target.value)}
                  required
                  maxLength={80}
                  placeholder="As it appears in Tally"
                />
                <span className="sub">
                  Required by po_issue_needs_tally. An order accounts has never seen cannot be matched to
                  an invoice later.
                </span>
              </div>

              {blocking.length > 0 && (
                <Banner kind="warn">
                  {blocking.length === 1 ? 'One check has' : `${blocking.length} checks have`} not passed yet.
                  Issuing will be refused until they do.
                </Banner>
              )}

              <button type="submit" className="btn btn-primary" disabled={act.busy || !tallyRef.trim() || blocking.length > 0}>
                {act.busy ? 'Issuing…' : 'Issue the order'}
              </button>
            </form>
          )}

          {po.status === 'PO_CREATED' && (
            <Banner kind="ok">
              Issued as <span className="mono">{po.tally_po_ref}</span>. It now appears in the receiving
              queue as an expected delivery.
            </Banner>
          )}

          {po.status === 'PO_DRAFT' && !canIssue && (
            <Banner kind="info">This order is waiting for a buyer to issue it.</Banner>
          )}
        </div>
      </Card>
    </>
  );
}
