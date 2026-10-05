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
import { Fragment, useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, Tile, fmtDate, fmtMoney, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { NewQuotationForm } from '@/app/(app)/pr/[id]/NewQuotationForm';
import { Documents } from '@/components/Documents';

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
  documents: number;
}

interface Comparison {
  quotes: Quote[];
  minRequired: number;
  needsWaiver: boolean;
  awarded: { id: number; quotation_id: number; is_lowest: boolean; reason_code: string | null } | null;
  /** The award clears a purchase order. Not the same as "lowest" — see the Award card. */
  cleared: boolean;
  clearedReason: string | null;
  po: { id: number; po_no: string; status: string } | null;
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
  /**
   * Which quote has its files open, if any. One at a time: the comparison is
   * what this screen is for, and four unfolded panels would bury it.
   *
   * Up here with the other hooks, NOT beside the markup it belongs to — the
   * early returns for loading and error sit between, and a hook after them runs
   * on some renders and not others. React counts them, and the second render
   * threw "rendered more hooks than during the previous render".
   */
  const [filesFor, setFilesFor] = useState<number | null>(null);
  const [awarding, setAwarding] = useState<number | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [justification, setJustification] = useState('');
  const [waiver, setWaiver] = useState('');

  const [poDate, setPoDate] = useState('');

  /**
   * Raise the purchase order from the award.
   *
   * Only the date is sent. Quantities come from the request and rates from the
   * awarded quotation, assembled on the server — a body that carried rates
   * would be a second opinion about what was awarded.
   */
  const raisePo = useMutation(
    async () => api.post('/api/po', { pr_id: prId, expected_delivery: poDate }),
    { onDone: onChanged, successMessage: 'Purchase order drafted.' },
  );

  /**
   * Decide the approval the award opened — its own chain, not the request's.
   * Without this the chain sat in the queue permanently and the request could
   * never become an order.
   */
  const decideAward = useMutation(
    async (approve: boolean) => api.post(`/api/pr/${prId}/award/decide`, { approve }),
    { onDone: onChanged, successMessage: 'Decision recorded.' },
  );

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

  const { quotes, minRequired, needsWaiver, awarded, cleared, clearedReason, po } = data;
  // These must be the keys the SERVICES enforce, or the button silently never
  // renders: `granted` is a plain array, so an unknown key is just `false` with
  // nothing logged. recordQuotation() checks QUOTATION.MANAGE and award()
  // checks AWARD.CREATE.
  const canRecord = granted.includes('QUOTATION.MANAGE') && !awarded && prStatus === 'PR_APPROVED';
  const canAward = granted.includes('AWARD.CREATE') && !awarded && prStatus === 'PR_APPROVED' && quotes.length > 0;
  // createPo() enforces PO.CREATE; the button has to ask for the same key.
  const canRaisePo = granted.includes('PO.CREATE') && prStatus === 'PR_APPROVED';
  // The award's own chain names AWARD.APPROVE_WAIVER or APPROVE_NON_LOWEST.
  // The server decides which applies; the screen only needs to know whether to
  // offer the control at all.
  const canDecideAward =
    granted.includes('AWARD.APPROVE_WAIVER') || granted.includes('AWARD.APPROVE_NON_LOWEST');

  const chosen = awarding === null ? null : quotes.find(q => q.quotationId === awarding) ?? null;
  const nonLowest = chosen !== null && chosen.rank !== 1;

  /**
   * A quote's own paperwork can still be filed after the award. It is evidence
   * of what was offered, not part of the decision — refusing it would only mean
   * the PDF lives in somebody's mailbox instead.
   */
  const canAttach = granted.includes('QUOTATION.MANAGE');

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
              <Fragment key={q.quotationId}>
              <div
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
                  {/*
                    Whether the vendor's own quote is on file, stated on the row
                    rather than hidden behind the panel -- "did anybody keep the
                    PDF?" is a question you ask while comparing, not after.
                  */}
                  <div className="sub">
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-expanded={filesFor === q.quotationId}
                      onClick={() => setFilesFor(v => (v === q.quotationId ? null : q.quotationId))}
                    >
                      {q.documents === 0
                        ? canAttach ? 'Attach the quote' : 'No file attached'
                        : `${q.documents} file${q.documents === 1 ? '' : 's'} attached`}
                    </button>
                  </div>
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

              {filesFor === q.quotationId && (
                // A sibling of the row, not a cell in it. A .tr is its own grid
                // of columns; the panel is one block the width of the table, so
                // it belongs beside the row rather than inside it.
                <div>
                  <Documents
                    entityType="QUOTATION"
                    entityId={q.quotationId}
                    offered={['QUOTATION', 'PRICE_LIST', 'TECHNICAL_SPEC']}
                    canAttach={canAttach}
                    // The count on the row comes from the comparison, so the
                    // comparison is what has to be refetched -- the panel
                    // reloading itself leaves the row saying "Attach the quote"
                    // next to a file that is plainly attached.
                    onChanged={reload}
                  />
                </div>
              )}
              </Fragment>
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
            {/*
              "Lowest" and "cleared" are different questions, and saying the
              first answers the second is how this card used to mislead: a
              lowest award made on too few quotations still opens a waiver
              chain, and no order can be raised until that is approved.
              `cleared` comes from awardCleared() on the server.
            */}
            <Banner kind={cleared ? 'ok' : 'warn'}>
              {awarded.is_lowest
                ? 'The lowest quotation was awarded.'
                : `A non-lowest quotation was awarded (${awarded.reason_code ?? 'reason recorded'}).`}
              {cleared ? ' It is cleared for a purchase order.' : ` ${clearedReason ?? ''}`}
            </Banner>

            {!cleared && canDecideAward && (
              <>
                {decideAward.error && <Banner kind="bad">{decideAward.error}</Banner>}
                <div className="seg" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={decideAward.busy}
                    onClick={() => void decideAward.run(true)}
                  >
                    {decideAward.busy ? 'Recording…' : 'Approve the award'}
                  </button>
                  <button type="button" className="btn" disabled={decideAward.busy} onClick={() => void decideAward.run(false)}>
                    Reject
                  </button>
                </div>
                <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
                  Rejecting leaves the award on the record but never cleared — a different quotation has to be awarded.
                </p>
              </>
            )}

            {po && (
              <p className="note" style={{ marginTop: 12, marginBottom: 0 }}>
                Purchase order <Link href={`/po/${po.id}`}>{po.po_no}</Link> has been raised from this award ({po.status
                  .replace('PO_', '')
                  .toLowerCase()}).
              </p>
            )}

            {!po && cleared && canRaisePo && (
              <>
                {raisePo.error && <Banner kind="bad">{raisePo.error}</Banner>}
                <div className="field" style={{ maxWidth: 260, marginTop: 12 }}>
                  <label htmlFor="po-expected">Expected delivery</label>
                  <input
                    id="po-expected"
                    type="date"
                    className="inp"
                    value={poDate}
                    onChange={e => setPoDate(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginTop: 12 }}
                  disabled={!poDate || raisePo.busy}
                  onClick={() => void raisePo.run(undefined)}
                >
                  {raisePo.busy ? 'Raising…' : 'Raise purchase order'}
                </button>
                <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
                  Quantities come from this request, rates from the awarded quotation. The order is drafted; issuing it
                  needs a Tally reference.
                </p>
              </>
            )}
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
