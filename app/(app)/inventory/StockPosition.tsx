'use client';

/**
 * Warehouse stock, one site at a time.
 *
 * The site picker is not a convenience — it is required. `v_stock_position`
 * cross-joins sites to items, so there is no "all sites" view to offer and the
 * screen does not pretend otherwise (conflict C-21).
 *
 * Balances are per site, item and bucket. There is deliberately no location
 * total anywhere on this screen: `stock_balances` has no location, and a
 * location figure would read as authoritative when nothing computes it
 * (conflict C-18). Locations appear on movements, in the ledger.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, fmtQty,
} from '@/components/ui';
import { useResource, useSession } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { AdjustForm } from '@/app/(app)/inventory/AdjustForm';

interface Position {
  site_id: number;
  item_id: number;
  code: string;
  name: string;
  uom: string;
  available: string;
  reserved: string;
  in_transit: string;
  damaged_hold: string;
  on_hand: string;
  reorder_level: string;
  stock_status: string;
  is_serialised: boolean;
}

const COLS = '1fr 110px 110px 110px 110px 130px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Below reorder', value: 'BELOW_REORDER' },
  { label: 'Near reorder', value: 'NEAR_REORDER' },
  { label: 'Healthy', value: 'HEALTHY' },
];

const STATUS_CHIP: Record<string, string> = {
  BELOW_REORDER: 'chip bad',
  NEAR_REORDER: 'chip warn',
  HEALTHY: 'chip ok',
};

export function StockPosition({ granted }: { granted: string[] }) {
  const session = useSession();
  const sites = useMemo(() => session.data?.sites ?? [], [session.data]);

  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [counting, setCounting] = useState<Position | null>(null);

  // A site has to be chosen before anything can be read, so the first one the
  // viewer holds is chosen for them.
  useEffect(() => {
    if (!siteId && sites.length > 0) setSiteId(String(sites[0].siteId));
  }, [sites, siteId]);

  const url = siteId ? `/api/inventory${qs({ site_id: siteId, status, search })}` : null;
  const { data, loading, error, reload } = useResource<Position[]>(url, [siteId, status, search]);

  const totals = useMemo(() => {
    const rows = data ?? [];
    return {
      items: rows.length,
      below: rows.filter(r => r.stock_status === 'BELOW_REORDER').length,
      damaged: rows.reduce((s, r) => s + Number(r.damaged_hold), 0),
      inTransit: rows.reduce((s, r) => s + Number(r.in_transit), 0),
    };
  }, [data]);

  const canAdjust = granted.includes('INVENTORY.ADJUST');
  const siteName = sites.find(s => String(s.siteId) === siteId)?.siteName ?? '';

  return (
    <>
      <Kpis>
        <Kpi label="Items held" value={totals.items} hint={siteName || 'Choose a site'} />
        <Kpi label="Below reorder" value={totals.below} hint="Needs a material request" tone={totals.below ? 'bad' : 'ok'} />
        <Kpi label="In transit" value={fmtQty(totals.inTransit)} hint="Dispatched, not yet received" tone={totals.inTransit ? 'info' : undefined} />
        <Kpi label="Damaged hold" value={fmtQty(totals.damaged)} hint="Quarantined, not issuable" tone={totals.damaged ? 'warn' : undefined} />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field" style={{ minWidth: 180 }}>
          <label htmlFor="inv-site">Site</label>
          <select id="inv-site" className="inp" value={siteId} onChange={e => setSiteId(e.target.value)}>
            {sites.map(s => (
              <option key={s.siteId} value={s.siteId}>{s.siteName}</option>
            ))}
          </select>
        </div>

        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor="inv-search">Search by code or name</label>
          <input id="inv-search" className="inp" value={search} onChange={e => setSearch(e.target.value)} placeholder="HDPE pallet" />
        </div>

        <div className="field">
          <span className="lbl">Level</span>
          <div className="seg" role="radiogroup" aria-label="Level">
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

        <Link className="btn" style={{ marginLeft: 'auto' }} href="/inventory/ledger">Stock ledger</Link>
      </section>

      {counting && (
        <AdjustForm
          siteId={Number(siteId)}
          item={counting}
          onClose={() => setCounting(null)}
          onDone={() => {
            setCounting(null);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading stock" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={search || status ? 'Nothing matches that' : `No stock at ${siteName}`}
          action={
            search || status ? (
              <button type="button" className="btn" onClick={() => { setSearch(''); setStatus(''); }}>Clear filters</button>
            ) : (
              <Link className="btn" href="/gate-inward">Receive a delivery</Link>
            )
          }
        >
          {search || status
            ? 'Try a different search or level.'
            : 'Stock appears here once a goods receipt is approved, or a transfer arrives from another site.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card
          title={`Stock at ${siteName}`}
          subtitle="Balances are per site, item and bucket. There is no per-location total — locations are recorded on movements, in the ledger."
          label="Stock position"
        >
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Item</div>
              <div className="r">Available</div>
              <div className="r">Reserved</div>
              <div className="r">In transit</div>
              <div className="r">Damaged</div>
              <div>Level</div>
            </div>
            {(data ?? []).map(r => (
              <div key={r.item_id} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div>
                  <Link href={`/inventory/ledger?site_id=${siteId}&item_id=${r.item_id}`} className="mono">
                    {r.code}
                  </Link>
                  <div className="sub">
                    {r.name}
                    {r.is_serialised && ' · serialised'}
                  </div>
                </div>
                <div className="r"><strong>{fmtQty(r.available)}</strong> <span className="sub">{r.uom}</span></div>
                <div className="r">{Number(r.reserved) ? fmtQty(r.reserved) : <span className="sub">—</span>}</div>
                <div className="r">{Number(r.in_transit) ? fmtQty(r.in_transit) : <span className="sub">—</span>}</div>
                <div className="r">{Number(r.damaged_hold) ? fmtQty(r.damaged_hold) : <span className="sub">—</span>}</div>
                <div>
                  <span className={STATUS_CHIP[r.stock_status] ?? 'chip'}>
                    {r.stock_status.replace(/_/g, ' ').toLowerCase()}
                  </span>
                  {Number(r.reorder_level) > 0 && (
                    <div className="sub">reorder at {fmtQty(r.reorder_level)}</div>
                  )}
                  {canAdjust && (
                    <div>
                      <button type="button" className="btn btn-sm" onClick={() => setCounting(r)}>Stock take</button>
                    </div>
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
