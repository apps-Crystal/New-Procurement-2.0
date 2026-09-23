'use client';

/**
 * Stock check, and the decision that follows it.
 *
 * `v_group_surplus` counts only what a holding site has ABOVE its own reorder
 * level, so a site is never stripped to the point where it would itself need to
 * reorder. That is why the surplus shown here is usually smaller than the raw
 * balance, and the panel says so rather than leaving the gap unexplained.
 *
 * Only `qty_transfer` is editable. The purchase balance is a generated column —
 * it is displayed, never typed.
 */
import { useMemo, useState } from 'react';
import { Banner, Card, Tile, fmtDateTime, fmtQty } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation } from '@/lib/client/use-resource';
import type { MrHeader } from '@/app/(app)/mr/[id]/MrDetail';

interface SurplusAtSite {
  site_id: number;
  site: string;
  surplus_qty: string;
}

interface StockCheckSnapshot {
  checked_at: string;
  available_here: string;
  surplus: SurplusAtSite[];
}

export interface MrLine {
  id: number;
  line_no: number;
  item_id: number;
  item_code: string;
  item_name: string;
  uom: string;
  qty_requested: string;
  qty_transfer: string;
  qty_purchase: string;
  stock_check: StockCheckSnapshot | null;
}

/** Statuses after which the lines, and so the split, are settled. */
const FROZEN = new Set([
  'MR_DECLARED', 'MR_APPROVED', 'MR_REJECTED',
  'MR_CONVERTED_TO_PR', 'MR_FULFILLED_INTERNAL', 'MR_CANCELLED',
]);

const CHECKED = new Set([
  'MR_STOCK_AVAILABLE', 'MR_STOCK_PARTIAL', 'MR_STOCK_UNAVAILABLE',
  'MR_TRANSFER_REQUESTED', 'MR_TRANSFER_APPROVED', 'MR_TRANSFER_REJECTED',
]);

const COLS = '1fr 100px 110px 1.2fr 120px';

export function StockCheckPanel({
  mr,
  lines,
  granted,
  onChanged,
}: {
  mr: MrHeader;
  lines: MrLine[];
  granted: string[];
  onChanged: () => void;
}) {
  const frozen = FROZEN.has(mr.status);
  const checked = CHECKED.has(mr.status) || lines.some(l => l.stock_check);

  const [draft, setDraft] = useState<Record<number, string>>(() =>
    Object.fromEntries(lines.map(l => [l.id, l.qty_transfer ?? '0'])),
  );

  const runCheck = useMutation(
    async () => api.post(`/api/mr/${mr.id}/stock-check`),
    { onDone: onChanged, successMessage: 'Stock check complete.' },
  );

  const saveSplit = useMutation(
    async () =>
      api.post(`/api/mr/${mr.id}/transfer-quantities`, {
        allocations: lines.map(l => ({ mr_line_id: l.id, qty_transfer: draft[l.id] || '0' })),
      }),
    { onDone: onChanged, successMessage: 'Transfer quantities saved.' },
  );

  /**
   * The holding site.
   *
   * A transfer order is raised against one sending site, so where more than one
   * site holds surplus the largest holder is offered. Splitting a line across
   * two senders would need two transfer orders, which is a deliberate second
   * action rather than something to do implicitly.
   */
  const fromSite = useMemo(() => {
    const totals = new Map<number, { id: number; name: string; qty: number }>();
    for (const line of lines) {
      for (const s of line.stock_check?.surplus ?? []) {
        const at = totals.get(s.site_id) ?? { id: s.site_id, name: s.site, qty: 0 };
        at.qty += Number(s.surplus_qty);
        totals.set(s.site_id, at);
      }
    }
    return [...totals.values()].sort((a, b) => b.qty - a.qty)[0] ?? null;
  }, [lines]);

  const transferLines = lines.filter(l => Number(draft[l.id] ?? 0) > 0);

  const requestTransfer = useMutation(
    async () =>
      api.post('/api/transfers', {
        mr_id: mr.id,
        from_site_id: fromSite?.id,
        to_site_id: Number(mr.site_id),
        lines: transferLines.map(l => ({
          item_id: l.item_id,
          qty: draft[l.id],
          mr_line_id: l.id,
        })),
      }),
    { onDone: onChanged, successMessage: 'Transfer requested.' },
  );

  const canCheck = granted.includes('MR.STOCK_CHECK') && !frozen;
  const canEdit = granted.includes('MR.EDIT') && !frozen && checked;
  const canRequest = granted.includes('MR.REQUEST_TRANSFER') && checked && !frozen;

  const dirty = lines.some(l => (draft[l.id] ?? '0') !== (l.qty_transfer ?? '0'));

  if (!checked) {
    return (
      <Card title="Stock check" label="Stock check">
        <div className="pad">
          {runCheck.error && <Banner kind="bad">{runCheck.error}</Banner>}
          <p className="sub" style={{ marginTop: 0 }}>
            Before anything is bought, the group is searched for the same item. Only surplus above each
            holding site&rsquo;s own reorder level counts, so no site is drained to supply another.
          </p>
          {canCheck ? (
            <button type="button" className="btn btn-primary" disabled={runCheck.busy} onClick={() => void runCheck.run(undefined)}>
              {runCheck.busy ? 'Checking…' : 'Run the stock check'}
            </button>
          ) : (
            <Banner kind="info">This request is waiting for its stock check.</Banner>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Stock check"
      subtitle={mr.stock_checked_at ? `Checked ${fmtDateTime(mr.stock_checked_at)}` : undefined}
      label="Stock check"
      right={
        canCheck ? (
          <button type="button" className="btn btn-sm" disabled={runCheck.busy} onClick={() => void runCheck.run(undefined)}>
            {runCheck.busy ? 'Checking…' : 'Re-run'}
          </button>
        ) : null
      }
    >
      <div className="tbl">
        <div className="tr th" style={{ gridTemplateColumns: COLS }}>
          <div>Item</div>
          <div className="r">Requested</div>
          <div className="r">Here</div>
          <div>Surplus elsewhere</div>
          <div className="r">Take by transfer</div>
        </div>

        {lines.map(l => {
          const snap = l.stock_check;
          const surplus = snap?.surplus ?? [];
          const total = surplus.reduce((s, x) => s + Number(x.surplus_qty), 0);
          const value = draft[l.id] ?? '0';
          const over = Number(value) > Number(l.qty_requested) || Number(value) > total;

          return (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: COLS }}>
              <div>
                <span className="mono">{l.item_code}</span>
                <div className="sub">{l.item_name}</div>
              </div>
              <div className="r">{fmtQty(l.qty_requested)} <span className="sub">{l.uom}</span></div>
              <div className="r">{fmtQty(snap?.available_here ?? 0)}</div>
              <div>
                {surplus.length === 0 ? (
                  <span className="sub">Nowhere in the group</span>
                ) : (
                  surplus.map(s => (
                    <div key={s.site_id} className="sub">
                      {s.site} — {fmtQty(s.surplus_qty)} {l.uom}
                    </div>
                  ))
                )}
              </div>
              <div className="r">
                {canEdit ? (
                  <>
                    <label htmlFor={`sc-${l.id}`} className="sr-only">
                      Quantity to transfer for {l.item_code}
                    </label>
                    <input
                      id={`sc-${l.id}`}
                      className="inp-sm"
                      inputMode="decimal"
                      value={value}
                      aria-invalid={over || undefined}
                      onChange={e => setDraft(d => ({ ...d, [l.id]: e.target.value }))}
                    />
                  </>
                ) : (
                  fmtQty(l.qty_transfer)
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="pad">
        {saveSplit.error && <Banner kind="bad">{saveSplit.error}</Banner>}
        {requestTransfer.error && <Banner kind="bad">{requestTransfer.error}</Banner>}

        <div className="grid g3" style={{ marginBottom: 12 }}>
          <Tile
            label="To transfer"
            value={fmtQty(lines.reduce((s, l) => s + Number(draft[l.id] ?? 0), 0))}
            hint="Moved from another site"
          />
          <Tile
            label="To purchase"
            value={fmtQty(lines.reduce((s, l) => s + Math.max(0, Number(l.qty_requested) - Number(draft[l.id] ?? 0)), 0))}
            hint="The balance a PR would carry"
          />
          <Tile
            label="Holding site"
            value={fromSite ? fromSite.name : '—'}
            hint={fromSite ? 'Largest surplus holder' : 'No surplus anywhere'}
          />
        </div>

        {canEdit && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={saveSplit.busy || !dirty} onClick={() => void saveSplit.run(undefined)}>
              {saveSplit.busy ? 'Saving…' : 'Save the split'}
            </button>

            {canRequest && mr.status !== 'MR_TRANSFER_REQUESTED' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={requestTransfer.busy || dirty || transferLines.length === 0 || !fromSite}
                onClick={() => void requestTransfer.run(undefined)}
              >
                {requestTransfer.busy ? 'Requesting…' : `Request transfer from ${fromSite?.name ?? 'the holding site'}`}
              </button>
            )}
          </div>
        )}

        {dirty && (
          <p className="sub" style={{ marginBottom: 0 }}>
            Save the split before requesting the transfer, so the two agree.
          </p>
        )}
      </div>
    </Card>
  );
}
