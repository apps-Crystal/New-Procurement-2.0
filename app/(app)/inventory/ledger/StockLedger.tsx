'use client';

/**
 * The stock ledger — append-only, and the whole explanation of every balance.
 *
 * Nothing here can be edited, which is the point (§29). A movement posted in
 * error is corrected by a reversal that mirrors it, and both entries stay
 * visible side by side. A row showing "reversed" is not a row that was undone;
 * it is a row that was answered.
 *
 * Location is a filter here and only here. `stock_balances` has no location, so
 * a filtered total is the sum of some movements, not the stock in a rack — the
 * screen says so rather than letting the number imply otherwise (C-18).
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Banner, Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, fmtDateTime, fmtQty,
} from '@/components/ui';
import { api, qs } from '@/lib/client/api';
import { useMutation, useResource, useSession } from '@/lib/client/use-resource';
import { ENUMS } from '@/lib/enums';

interface Entry {
  id: number;
  entry_no: string;
  site_id: number;
  site_name: string;
  item_code: string;
  item_name: string;
  uom: string;
  movement: string;
  from_bucket: string | null;
  to_bucket: string | null;
  qty: string;
  location_code: string | null;
  asset_tag: string | null;
  source_type: string;
  source_id: number;
  moved_by_name: string | null;
  posted_at: string;
  remarks: string | null;
  is_reversed: boolean;
}

const COLS = '150px 1fr 190px 110px 150px 120px';

/** How a movement reads in the bucket column. */
function direction(e: Entry): string {
  const from = e.from_bucket?.replace(/_/g, ' ').toLowerCase() ?? 'outside';
  const to = e.to_bucket?.replace(/_/g, ' ').toLowerCase() ?? 'outside';
  return `${from} → ${to}`;
}

export function StockLedger({ granted }: { granted: string[] }) {
  const params = useSearchParams();
  const session = useSession();

  const [siteId, setSiteId] = useState(params.get('site_id') ?? '');
  const [itemId] = useState(params.get('item_id') ?? '');
  const [movement, setMovement] = useState('');
  const [reversing, setReversing] = useState<Entry | null>(null);
  const [remarks, setRemarks] = useState('');

  const url = `/api/inventory/ledger${qs({ site_id: siteId, item_id: itemId, movement })}`;
  const { data, loading, error, reload } = useResource<Entry[]>(url, [siteId, itemId, movement]);

  const reverse = useMutation(
    async (entryId: number) => api.post('/api/inventory/reverse', { entry_id: entryId, remarks }),
    { onDone: () => { setReversing(null); setRemarks(''); reload(); } },
  );

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      reversals: rows.filter(r => r.movement === 'REVERSAL').length,
      reversed: rows.filter(r => r.is_reversed).length,
    };
  }, [data]);

  const canReverse = granted.includes('INVENTORY.REVERSE');
  const sites = session.data?.sites ?? [];
  const filtered = siteId !== '' || itemId !== '' || movement !== '';

  return (
    <>
      <Kpis>
        <Kpi label="Entries shown" value={counts.total} hint="Newest first, capped at 200" />
        <Kpi label="Reversals" value={counts.reversals} hint="Corrections posted" tone={counts.reversals ? 'warn' : undefined} />
        <Kpi label="Entries reversed" value={counts.reversed} hint="Answered, not deleted" />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field" style={{ minWidth: 180 }}>
          <label htmlFor="led-site">Site</label>
          <select id="led-site" className="inp" value={siteId} onChange={e => setSiteId(e.target.value)}>
            <option value="">Every site I can see</option>
            {sites.map(s => (
              <option key={s.siteId} value={s.siteId}>{s.siteName}</option>
            ))}
          </select>
        </div>

        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="led-movement">Movement</label>
          <select id="led-movement" className="inp" value={movement} onChange={e => setMovement(e.target.value)}>
            <option value="">All movements</option>
            {ENUMS.movement_type.map(m => (
              <option key={m} value={m}>{m.replace(/_/g, ' ').toLowerCase()}</option>
            ))}
          </select>
        </div>

        {itemId && (
          <div className="field">
            <span className="lbl">Item</span>
            <div style={{ paddingTop: 8 }}>
              <Link className="btn btn-sm" href="/inventory/ledger">Clear item filter</Link>
            </div>
          </div>
        )}

        <Link className="btn" style={{ marginLeft: 'auto' }} href="/inventory">Back to stock</Link>
      </section>

      {reversing && (
        <Card title={`Reverse ${reversing.entry_no}`} label="Reverse">
          <form
            className="pad"
            onSubmit={e => {
              e.preventDefault();
              void reverse.run(reversing.id);
            }}
          >
            {reverse.error && <Banner kind="bad">{reverse.error}</Banner>}

            <Banner kind="warn">
              This posts a mirror of {reversing.movement.replace(/_/g, ' ').toLowerCase()} —{' '}
              {fmtQty(reversing.qty)} {reversing.uom} of {reversing.item_name}. The original entry stays
              exactly as it is; the correction sits beside it.
            </Banner>

            <div className="field">
              <label htmlFor="rev-why">Why is this being reversed?</label>
              <textarea
                id="rev-why"
                className="inp"
                rows={2}
                value={remarks}
                onChange={e => setRemarks(e.target.value)}
                required
                minLength={4}
                maxLength={500}
                placeholder="What was wrong with the original posting."
              />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" className="btn btn-primary" disabled={reverse.busy || remarks.trim().length < 4}>
                {reverse.busy ? 'Reversing…' : 'Post the reversal'}
              </button>
              <button type="button" className="btn" onClick={() => setReversing(null)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}

      {loading && <LoadingState rows={8} label="Loading the ledger" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={filtered ? 'No movements match that' : 'The ledger is empty'}
          action={filtered ? <Link className="btn" href="/inventory/ledger">Clear filters</Link> : null}
        >
          {filtered
            ? 'Try a different site or movement type.'
            : 'Every change to stock is written here — receipts, transfers, issues, damage and corrections.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card
          title="Movements"
          subtitle="Append-only. A mistake is corrected by a reversal, never by an edit."
          label="Stock ledger"
        >
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Entry</div>
              <div>Item and reason</div>
              <div>Movement</div>
              <div className="r">Quantity</div>
              <div>When and who</div>
              <div />
            </div>
            {(data ?? []).map(e => (
              <div key={e.id} className="tr" style={{ gridTemplateColumns: COLS, opacity: e.is_reversed ? 0.6 : 1 }}>
                <div className="mono">
                  {e.entry_no}
                  {e.is_reversed && <div className="sub">reversed</div>}
                </div>
                <div>
                  <span className="mono">{e.item_code}</span>
                  <div className="sub">
                    {e.site_name}
                    {e.location_code && ` · ${e.location_code}`}
                    {e.asset_tag && ` · ${e.asset_tag}`}
                  </div>
                  {e.remarks && <div className="sub">{e.remarks}</div>}
                </div>
                <div>
                  {e.movement.replace(/_/g, ' ').toLowerCase()}
                  <div className="sub">{direction(e)}</div>
                </div>
                <div className="r">
                  {fmtQty(e.qty)} <span className="sub">{e.uom}</span>
                </div>
                <div className="sub">
                  {fmtDateTime(e.posted_at)}
                  <div>{e.moved_by_name}</div>
                </div>
                <div>
                  {canReverse && !e.is_reversed && e.movement !== 'REVERSAL' && (
                    <button type="button" className="btn btn-sm" onClick={() => { setReversing(e); setRemarks(''); }}>
                      Reverse
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
