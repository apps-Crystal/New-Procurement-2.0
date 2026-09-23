'use client';

/**
 * Purchase request detail — value, approval chain, then quotations.
 *
 * Two things this screen deliberately does not do:
 *
 *   It does not add up the lines. Totals come from `v_pr_totals`, because the
 *   number shown and the number the approval band routes on must be the same.
 *
 *   It does not decide who approves. The chain is rows in `approvals`, opened
 *   from `approval_bands` by value, and a level is decided one at a time in
 *   order — level 2 cannot act before level 1 has.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDate, fmtDateTime, fmtMoney, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { QuotationPanel } from '@/app/(app)/pr/[id]/QuotationPanel';

interface Row { [k: string]: unknown }

interface PrView {
  pr: Row & {
    id: number; pr_no: string; status: string; site_name: string; site_id: number;
    requester_id: number; requester_name: string; mr_id: number; mr_no: string;
    budget_code: string; procurement_type: string; purpose: string;
    expected_delivery: string; business_impact: string | null;
    suggested_vendor_name: string | null; created_at: string;
  };
  lines: (Row & {
    id: number; line_no: number; item_code: string; item_name: string; uom: string;
    qty: string; est_rate: string; gst_rate: string;
    line_taxable: string; line_gst: string; line_total: string;
  })[];
  totals: (Row & { taxable: string; gst: string; total_incl_gst: string }) | null;
  approvals: (Row & {
    id: number; level_no: number; required_role: string; state: string;
    approver_id: number | null; approver_name: string | null;
    decided_at: string | null; remarks: string | null;
  })[];
}

const LINE_COLS = '40px 1fr 110px 120px 70px 130px';

export function PrDetail({
  id,
  granted,
  userId,
  roles,
}: {
  id: number;
  granted: string[];
  userId: number;
  roles: string[];
}) {
  const { data, loading, error, reload } = useResource<PrView>(`/api/pr/${id}`);
  const [rejecting, setRejecting] = useState(false);
  const [remarks, setRemarks] = useState('');

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/pr/${id}/transition`, body),
    { onDone: () => { setRejecting(false); setRemarks(''); reload(); } },
  );

  if (loading) return <LoadingState rows={8} label="Loading the request" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { pr, lines, totals, approvals } = data;

  const isOriginator = Number(pr.requester_id) === userId;
  const canSubmit = pr.status === 'PR_DRAFT' && granted.includes('PR.SUBMIT') && isOriginator;

  // The first level still pending is the only one that can act. The server
  // checks this too — an out-of-order decision is refused there.
  const current = approvals.find(a => a.state === 'PENDING') ?? null;
  const myTurn =
    current !== null &&
    pr.status === 'PR_SUBMITTED' &&
    !isOriginator &&
    roles.includes(current.required_role);

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{pr.pr_no}</span> <StatusChip status={pr.status} />
            </h2>
            <span className="sub">
              {pr.site_name} · raised by {pr.requester_name} on {fmtDate(pr.created_at)} from{' '}
              <Link href={`/mr/${pr.mr_id}`} className="mono">{pr.mr_no}</Link>
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile label="Taxable" value={totals ? `₹${fmtMoney(totals.taxable)}` : '—'} hint="From v_pr_totals" />
          <Tile label="GST" value={totals ? `₹${fmtMoney(totals.gst)}` : '—'} hint="Rounded per line" />
          <Tile
            label="Total"
            value={totals ? `₹${fmtMoney(totals.total_incl_gst)}` : '—'}
            hint="What the approval band routes on"
          />
          <Tile label="Wanted by" value={fmtDate(pr.expected_delivery)} hint={pr.budget_code} />
        </div>

        <div className="pad" style={{ paddingTop: 0 }}>
          <span className="lbl">Purpose</span>
          <p style={{ margin: '4px 0 0' }}>{pr.purpose}</p>
          {pr.business_impact && (
            <>
              <span className="lbl" style={{ display: 'block', marginTop: 12 }}>
                Declared impact, carried from the material request
              </span>
              <p className="sub" style={{ margin: '4px 0 0' }}>{pr.business_impact}</p>
            </>
          )}
        </div>
      </Card>

      <Card title="Lines" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: LINE_COLS }}>
            <div>#</div>
            <div>Item</div>
            <div className="r">Quantity</div>
            <div className="r">Rate</div>
            <div className="r">GST</div>
            <div className="r">Total</div>
          </div>
          {lines.map(l => (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: LINE_COLS }}>
              <div className="sub">{l.line_no}</div>
              <div>
                <span className="mono">{l.item_code}</span>
                <div className="sub">{l.item_name}</div>
              </div>
              <div className="r">{fmtQty(l.qty)} <span className="sub">{l.uom}</span></div>
              <div className="r">₹{fmtMoney(l.est_rate)}</div>
              <div className="r sub">{l.gst_rate}%</div>
              <div className="r">₹{fmtMoney(l.line_total)}</div>
            </div>
          ))}
        </div>
      </Card>

      {approvals.length > 0 && (
        <Card title="Approval chain" label="Approvals">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: '70px 160px 1fr 150px 130px' }}>
              <div>Level</div>
              <div>Required role</div>
              <div>Decided by</div>
              <div>When</div>
              <div>State</div>
            </div>
            {approvals.map(a => (
              <div key={a.id} className="tr" style={{ gridTemplateColumns: '70px 160px 1fr 150px 130px' }}>
                <div className="sub">{a.level_no}</div>
                <div className="mono">{a.required_role}</div>
                <div>
                  {a.approver_name ?? <span className="sub">Not yet</span>}
                  {a.remarks && <div className="sub">{a.remarks}</div>}
                </div>
                <div className="sub">{a.decided_at ? fmtDateTime(a.decided_at) : '—'}</div>
                <div><StatusChip status={a.state} /></div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {canSubmit && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Submitting fixes the value and opens the approval chain. The levels are chosen by that
                value, and the request cannot be edited once it is approved.
              </p>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'submit' })}>
                {act.busy ? 'Submitting…' : 'Submit for approval'}
              </button>
            </>
          )}

          {pr.status === 'PR_SUBMITTED' && isOriginator && (
            <Banner kind="warn">
              You raised this request, so you cannot approve it. It is with {current?.required_role ?? 'the approver'}.
            </Banner>
          )}

          {pr.status === 'PR_SUBMITTED' && !isOriginator && !myTurn && current && (
            <Banner kind="info">
              Level {current.level_no} is next, and needs {current.required_role}. Later levels cannot act
              until it has.
            </Banner>
          )}

          {myTurn && !rejecting && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'approve' })}>
                {act.busy ? 'Approving…' : `Approve at level ${current?.level_no}`}
              </button>
              <button type="button" className="btn" onClick={() => setRejecting(true)}>Reject</button>
            </div>
          )}

          {myTurn && rejecting && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'reject', remarks });
              }}
            >
              <div className="field">
                <label htmlFor="pr-reject">Why is this being rejected?</label>
                <textarea
                  id="pr-reject"
                  className="inp"
                  rows={3}
                  value={remarks}
                  onChange={e => setRemarks(e.target.value)}
                  required
                  minLength={4}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || remarks.trim().length < 4}>
                  {act.busy ? 'Rejecting…' : 'Confirm rejection'}
                </button>
                <button type="button" className="btn" onClick={() => setRejecting(false)}>Cancel</button>
              </div>
            </form>
          )}

          {pr.status === 'PR_APPROVED' && (
            <Banner kind="ok">
              Approved. Collect quotations below, compare them, and award one before raising the order.
            </Banner>
          )}

          {pr.status === 'PO_POSTED' && (
            <Banner kind="ok">
              An order has been raised against this request. One PO per PR — see conflict C-17.
            </Banner>
          )}
        </div>
      </Card>

      {(pr.status === 'PR_APPROVED' || pr.status === 'PO_POSTED') && (
        <QuotationPanel prId={pr.id} prStatus={pr.status} lines={lines} granted={granted} onChanged={reload} />
      )}
    </>
  );
}
