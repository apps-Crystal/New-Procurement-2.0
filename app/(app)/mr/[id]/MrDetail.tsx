'use client';

/**
 * Material request detail — the stages, in order.
 *
 * The screen is built around the state machine rather than around the record:
 * what you can do is whatever the current status allows, so the actions appear
 * and disappear as the request moves. Every one of them is also checked
 * server-side; hiding a button is presentation only (§13).
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Steps,
  Tile, fmtDate, fmtDateTime, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { DeclarationForm } from '@/app/(app)/mr/[id]/DeclarationForm';
import { StockCheckPanel, type MrLine } from '@/app/(app)/mr/[id]/StockCheckPanel';

interface Row { [k: string]: unknown }

export interface MrHeader extends Row {
  id: number;
  mr_no: string;
  status: string;
  site_id: number;
  site_code: string;
  site_name: string;
  category: string;
  urgency: string;
  required_by: string;
  requester_id: number;
  requester_name: string;
  created_at: string;
  stock_checked_at: string | null;
}

interface MrView {
  mr: MrHeader;
  lines: MrLine[];
  declaration: (Row & {
    id: number; business_impact: string; budget_code: string; estimated_value: string;
    accepted_by_name: string; accepted_at: string; version: number;
  }) | null;
  allocations: (Row & { id: number; site_name: string; cost_head: string; pct: string })[];
}

const LINE_COLS = '50px 1fr 110px 110px 110px 70px';

/** The stages, and which statuses count as having reached each one. */
const STAGES: { label: string; sub: string; reached: string[] }[] = [
  { label: 'Raised', sub: 'What the site needs', reached: ['MR_DRAFT'] },
  {
    label: 'Stock checked',
    sub: 'Against group surplus',
    reached: ['MR_STOCK_AVAILABLE', 'MR_STOCK_PARTIAL', 'MR_STOCK_UNAVAILABLE'],
  },
  {
    label: 'Transfer',
    sub: 'Move what the group has',
    reached: ['MR_TRANSFER_REQUESTED', 'MR_TRANSFER_APPROVED', 'MR_TRANSFER_REJECTED'],
  },
  { label: 'Declared', sub: 'Business impact stated', reached: ['MR_DECLARED'] },
  {
    label: 'Approved',
    sub: 'Cleared to purchase',
    reached: ['MR_APPROVED', 'MR_CONVERTED_TO_PR', 'MR_FULFILLED_INTERNAL'],
  },
];

function stageIndex(status: string): number {
  const at = STAGES.findIndex(s => s.reached.includes(status));
  if (at >= 0) return at;
  // Rejected and cancelled sit outside the happy path. Showing the whole run as
  // finished stops the chart implying the request is still moving.
  return STAGES.length;
}

export function MrDetail({ id, granted, userId }: { id: number; granted: string[]; userId: number }) {
  const { data, loading, error, reload } = useResource<MrView>(`/api/mr/${id}`);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const decide = useMutation(
    async (args: { approve: boolean; reason?: string }) =>
      api.post(`/api/mr/${id}/transition`, {
        action: args.approve ? 'approve' : 'reject',
        reason: args.reason,
      }),
    { onDone: () => { setRejecting(false); setReason(''); reload(); } },
  );

  if (loading) return <LoadingState rows={8} label="Loading the request" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { mr, lines, declaration, allocations } = data;
  const at = stageIndex(mr.status);

  const isOriginator = Number(mr.requester_id) === userId;
  const awaitingDecision = mr.status === 'MR_DECLARED';
  const canDecide = granted.includes('MR.APPROVE') && awaitingDecision && !isOriginator;
  const canDeclare = granted.includes('MR.DECLARE');

  const toTransfer = lines.reduce((s, l) => s + Number(l.qty_transfer ?? 0), 0);
  const toPurchase = lines.reduce((s, l) => s + Number(l.qty_purchase ?? 0), 0);

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{mr.mr_no}</span> <StatusChip status={mr.status} />
            </h2>
            <span className="sub">
              Raised by {mr.requester_name} on {fmtDate(mr.created_at)} for {mr.site_name}
            </span>
          </div>
          {mr.status === 'MR_APPROVED' && toPurchase > 0 && granted.includes('PR.CREATE') && (
            <Link className="btn btn-primary" href={`/pr?from_mr=${mr.id}`}>Raise a purchase request</Link>
          )}
        </div>

        <div className="pad grid g4">
          <Tile label="Category" value={mr.category.replace(/_/g, ' ').toLowerCase()} />
          <Tile label="Urgency" value={mr.urgency.toLowerCase()} />
          <Tile label="Needed by" value={fmtDate(mr.required_by)} />
          <Tile
            label="Stock checked"
            value={mr.stock_checked_at ? fmtDateTime(mr.stock_checked_at) : 'Not yet'}
            hint={mr.stock_checked_at ? 'Re-run if older than 72 hours' : undefined}
          />
        </div>
      </Card>

      <Steps
        steps={STAGES.map((s, i) => ({
          label: s.label,
          sub: s.sub,
          state: i < at ? 'done' : i === at ? 'now' : 'todo',
        }))}
      />

      <Card title="What was asked for" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: LINE_COLS }}>
            <div>#</div>
            <div>Item</div>
            <div className="r">Requested</div>
            <div className="r">By transfer</div>
            <div className="r">To purchase</div>
            <div>Unit</div>
          </div>
          {lines.map(l => (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: LINE_COLS }}>
              <div className="sub">{l.line_no}</div>
              <div>
                <span className="mono">{l.item_code}</span>
                <div className="sub">{l.item_name}</div>
              </div>
              <div className="r">{fmtQty(l.qty_requested)}</div>
              <div className="r">
                {Number(l.qty_transfer) > 0 ? fmtQty(l.qty_transfer) : <span className="sub">—</span>}
              </div>
              <div className="r">{fmtQty(l.qty_purchase)}</div>
              <div className="sub">{l.uom}</div>
            </div>
          ))}
        </div>
        {(toTransfer > 0 || toPurchase > 0) && (
          <div className="pad sub" style={{ borderTop: '1px solid var(--line-2)' }}>
            {fmtQty(toTransfer)} to come by transfer, {fmtQty(toPurchase)} to be purchased. The purchase
            balance is a generated column — it follows from the transfer quantity and cannot be set against it.
          </div>
        )}
      </Card>

      <StockCheckPanel mr={mr} lines={lines} granted={granted} onChanged={reload} />

      {declaration ? (
        <Card title="Business impact declaration" label="Declaration">
          <div className="pad">
            <p style={{ marginTop: 0 }}>{declaration.business_impact}</p>
            <div className="grid g3" style={{ marginTop: 14 }}>
              <Tile label="Budget code" value={declaration.budget_code} />
              <Tile label="Estimated value" value={`₹${declaration.estimated_value}`} />
              <Tile
                label="Accepted"
                value={declaration.accepted_by_name}
                hint={`${fmtDateTime(declaration.accepted_at)} · version ${declaration.version}`}
              />
            </div>
            {allocations.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <span className="lbl">Cost allocation</span>
                <div className="tbl" style={{ marginTop: 6 }}>
                  <div className="tr th" style={{ gridTemplateColumns: '1fr 1fr 90px' }}>
                    <div>Site</div>
                    <div>Cost head</div>
                    <div className="r">Share</div>
                  </div>
                  {allocations.map(a => (
                    <div key={a.id} className="tr" style={{ gridTemplateColumns: '1fr 1fr 90px' }}>
                      <div>{a.site_name}</div>
                      <div className="sub">{a.cost_head}</div>
                      <div className="r">{a.pct}%</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      ) : (
        canDeclare && <DeclarationForm mrId={mr.id} siteId={Number(mr.site_id)} status={mr.status} onDone={reload} />
      )}

      {awaitingDecision && (
        <Card title="Decision" label="Decision">
          <div className="pad">
            {decide.error && <Banner kind="bad">{decide.error}</Banner>}

            {isOriginator && (
              <Banner kind="warn">
                You raised this request, so it has to be approved by someone else. The database enforces that
                too — the mr_self_approval trigger would refuse it.
              </Banner>
            )}

            {!isOriginator && !granted.includes('MR.APPROVE') && (
              <Banner kind="info">This request is waiting for a site manager to decide it.</Banner>
            )}

            {canDecide && !rejecting && (
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={decide.busy}
                  onClick={() => void decide.run({ approve: true })}
                >
                  {decide.busy ? 'Approving…' : 'Approve'}
                </button>
                <button type="button" className="btn" onClick={() => setRejecting(true)}>Reject</button>
              </div>
            )}

            {canDecide && rejecting && (
              <form
                onSubmit={e => {
                  e.preventDefault();
                  void decide.run({ approve: false, reason });
                }}
              >
                <div className="field">
                  <label htmlFor="mr-reject">Why is this being rejected?</label>
                  <textarea
                    id="mr-reject"
                    className="inp"
                    rows={3}
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    required
                    minLength={4}
                    placeholder="The requester will see this."
                  />
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="submit" className="btn btn-primary" disabled={decide.busy || reason.trim().length < 4}>
                    {decide.busy ? 'Rejecting…' : 'Confirm rejection'}
                  </button>
                  <button type="button" className="btn" onClick={() => setRejecting(false)}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
