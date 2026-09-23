'use client';

/**
 * Quotations and the comparative statement.
 *
 * Rank, landed cost and the variance to L1 come from `v_quotation_landed_cost`
 * and are rendered in the order given. The panel never sorts: a client-side
 * sort would be a second opinion about which quote is lowest, and the award is
 * checked against the view's, not this screen's.
 *
 * Awarding anything other than rank 1 needs a reason code and a justification
 * (`awards_nonlow`), and awarding on fewer quotations than the minimum needs a
 * waiver. Either opens an approval chain of its own before a PO can follow.
 */
import { useState } from 'react';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, Tile, fmtDate, fmtMoney, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { NewQuotationForm } from '@/app/(app)/pr/[id]/NewQuotationForm';

interface Quote {
  quotationId: number;
  vendorId: number;
  vendorName: string;
  vendorQuoteRef: string;
  quoteDate: string;
  validUntil: string;
  expired: boolean;
  taxable: string;
  gst: string;
  freight: string;
  landedCost: string;
  rank: number;
  varianceToL1: string;
  paymentTerms: string | null;
  warrantyMonths: number | null;
  scorecard: { rejectionPct: string | null; returns12m: number; qtyDelivered: string } | null;
}

interface Comparison {
  quotes: Quote[];
  minRequired: number;
  needsWaiver: boolean;
  awarded: { id: number; quotation_id: number; is_lowest: boolean; reason_code: string | null } | null;
}

export interface PrLine {
  id: number;
  item_code: string;
  item_name: string;
  uom: string;
  qty: string;
  gst_rate: string;
}

const REASONS = [
  'EARLIER_DELIVERY',
  'BETTER_WARRANTY',
  'PROVEN_QUALITY',
  'APPROVED_MAKE_ONLY',
  'L1_WITHDREW',
  'PAYMENT_TERMS',
];

export function QuotationPanel({
  prId,
  prStatus,
  lines,
  granted,
  onChanged,
}: {
  prId: number;
  prStatus: string;
  lines: PrLine[];
  granted: string[];
  onChanged: () => void;
}) {
  const { data, loading, error, reload } = useResource<Comparison>(`/api/pr/${prId}/comparison`);
  const [recording, setRecording] = useState(false);
  const [awarding, setAwarding] = useState<number | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [justification, setJustification] = useState('');
  const [waiver, setWaiver] = useState('');

  const awardQuote = useMutation(
    async (quotationId: number) =>
      api.post(`/api/pr/${prId}/award`, {
        quotation_id: quotationId,
        reason_code: reasonCode || null,
        justification: justification || null,
        waiver_reason: waiver || null,
      }),
    {
      onDone: () => {
        setAwarding(null);
        setReasonCode('');
        setJustification('');
        setWaiver('');
        reload();
        onChanged();
      },
    },
  );

  if (loading) return <LoadingState rows={5} label="Loading quotations" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return null;

  const { quotes, minRequired, needsWaiver, awarded } = data;
  const canRecord = granted.includes('QUOTATION.CREATE') && !awarded && prStatus === 'PR_APPROVED';
  const canAward = granted.includes('QUOTATION.AWARD') && !awarded && prStatus === 'PR_APPROVED' && quotes.length > 0;

  const chosen = awarding === null ? null : quotes.find(q => q.quotationId === awarding) ?? null;
  const nonLowest = chosen !== null && chosen.rank !== 1;

  return (
    <>
      <Card
        title="Quotations"
        subtitle={`${quotes.length} received · ${minRequired} required for this value`}
        label="Quotations"
        right={
          canRecord ? (
            <button type="button" className="btn btn-sm" onClick={() => setRecording(v => !v)}>
              {recording ? 'Close' : 'Record a quotation'}
            </button>
          ) : null
        }
      >
        {quotes.length === 0 ? (
          <EmptyState title="No quotations yet">
            Record what each vendor quoted. Only approved vendors can be quoted against, and each vendor
            may have one live quotation per request.
          </EmptyState>
        ) : (
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: '60px 1.4fr 130px 130px 110px 120px 130px' }}>
              <div>Rank</div>
              <div>Vendor</div>
              <div className="r">Taxable</div>
              <div className="r">Freight</div>
              <div className="r">GST</div>
              <div className="r">Landed cost</div>
              <div className="r">vs L1</div>
            </div>
            {quotes.map(q => (
              <div
                key={q.quotationId}
                className="tr"
                style={{
                  gridTemplateColumns: '60px 1.4fr 130px 130px 110px 120px 130px',
                  opacity: q.expired ? 0.55 : 1,
                }}
              >
                <div>
                  <span className={q.rank === 1 ? 'chip ok' : 'chip'}>L{q.rank}</span>
                </div>
                <div>
                  {q.vendorName}
                  <div className="sub">
                    <span className="mono">{q.vendorQuoteRef}</span> · quoted {fmtDate(q.quoteDate)} · valid to{' '}
                    {fmtDate(q.validUntil)}
                    {q.expired && <strong> — expired</strong>}
                  </div>
                  {q.scorecard && (
                    <div className="sub">
                      {q.scorecard.rejectionPct === null
                        ? 'No delivery history yet'
                        : `${q.scorecard.rejectionPct}% rejected on ${fmtQty(q.scorecard.qtyDelivered)} delivered · ${q.scorecard.returns12m} returns in 12 months`}
                    </div>
                  )}
                </div>
                <div className="r">₹{fmtMoney(q.taxable)}</div>
                <div className="r">₹{fmtMoney(q.freight)}</div>
                <div className="r">₹{fmtMoney(q.gst)}</div>
                <div className="r"><strong>₹{fmtMoney(q.landedCost)}</strong></div>
                <div className="r">
                  {q.rank === 1 ? (
                    <span className="sub">lowest</span>
                  ) : (
                    <span className="sub">+₹{fmtMoney(q.varianceToL1)}</span>
                  )}
                  {canAward && (
                    <div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setAwarding(q.quotationId)}
                        disabled={q.expired}
                      >
                        {q.expired ? 'Expired' : 'Award'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {recording && (
          <NewQuotationForm
            prId={prId}
            lines={lines}
            onClose={() => setRecording(false)}
            onSaved={() => {
              setRecording(false);
              reload();
            }}
          />
        )}
      </Card>

      {awarded && (
        <Card title="Award" label="Award">
          <div className="pad">
            <Banner kind={awarded.is_lowest ? 'ok' : 'warn'}>
              {awarded.is_lowest
                ? 'The lowest quotation was awarded, so no further approval was needed.'
                : `A non-lowest quotation was awarded (${awarded.reason_code ?? 'reason recorded'}). That needs its own approval before the order can be raised.`}
            </Banner>
          </div>
        </Card>
      )}

      {awarding !== null && chosen && (
        <Card title={`Award to ${chosen.vendorName}`} label="Award">
          <form
            className="pad"
            onSubmit={e => {
              e.preventDefault();
              void awardQuote.run(chosen.quotationId);
            }}
          >
            {awardQuote.error && <Banner kind="bad">{awardQuote.error}</Banner>}

            <div className="grid g3" style={{ marginBottom: 12 }}>
              <Tile label="Landed cost" value={`₹${fmtMoney(chosen.landedCost)}`} hint={`Rank L${chosen.rank}`} />
              <Tile label="Payment terms" value={chosen.paymentTerms ?? '—'} />
              <Tile
                label="Warranty"
                value={chosen.warrantyMonths ? `${chosen.warrantyMonths} months` : '—'}
              />
            </div>

            {nonLowest && (
              <>
                <Banner kind="warn">
                  This is not the lowest quotation. The schema requires a reason code and a justification,
                  and the award will need approving before a PO can follow.
                </Banner>

                <div className="grid g2">
                  <div className="field">
                    <label htmlFor="aw-reason">Reason code</label>
                    <select id="aw-reason" className="inp" value={reasonCode} onChange={e => setReasonCode(e.target.value)} required>
                      <option value="">Choose…</option>
                      {REASONS.map(r => (
                        <option key={r} value={r}>{r.replace(/_/g, ' ').toLowerCase()}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="aw-just">Justification</label>
                    <input
                      id="aw-just"
                      className="inp"
                      value={justification}
                      onChange={e => setJustification(e.target.value)}
                      required
                      minLength={10}
                      maxLength={1000}
                      placeholder="What this buys that the lowest quote does not."
                    />
                  </div>
                </div>
              </>
            )}

            {needsWaiver && (
              <div className="field">
                <label htmlFor="aw-waiver">
                  Only {quotes.length} of {minRequired} quotations — why proceed?
                </label>
                <input
                  id="aw-waiver"
                  className="inp"
                  value={waiver}
                  onChange={e => setWaiver(e.target.value)}
                  required
                  maxLength={500}
                  placeholder="e.g. sole approved supplier for this make"
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button type="submit" className="btn btn-primary" disabled={awardQuote.busy}>
                {awardQuote.busy ? 'Awarding…' : 'Confirm award'}
              </button>
              <button type="button" className="btn" onClick={() => setAwarding(null)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
