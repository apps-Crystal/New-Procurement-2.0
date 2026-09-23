'use client';

/**
 * The asset register — one row per physical unit of a serialised item.
 *
 * Units are created when a goods receipt is approved, never by hand: a unit
 * that exists without a receipt behind it is a unit nobody can account for.
 * Their bucket follows the ledger automatically, so it is shown here and not
 * editable — what can be corrected is the serial number, the location and the
 * warranty date.
 *
 * The drift banner is conflict C-19 made visible. A serialised item is counted
 * twice by the schema — per unit and in aggregate — and nothing in the database
 * keeps the two together. When they disagree, that is reported rather than
 * quietly repaired: which of the two is right is a warehouse question.
 */
import { useMemo, useState } from 'react';
import {
  Banner, Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, fmtDate, fmtQty,
} from '@/components/ui';
import { api, qs } from '@/lib/client/api';
import { useMutation, useResource, useSession } from '@/lib/client/use-resource';
import { ENUMS } from '@/lib/enums';

interface Asset {
  id: number;
  asset_tag: string;
  serial_no: string | null;
  item_code: string;
  item_name: string;
  site_name: string;
  bucket: string;
  location_code: string | null;
  warranty_until: string | null;
  in_warranty: boolean;
  grn_no: string | null;
  vendor_name: string | null;
}

interface Drift {
  siteId: number;
  siteName: string;
  itemCode: string;
  bucket: string;
  balanceQty: string;
  unitCount: number;
}

const COLS = '180px 1fr 140px 130px 150px';

const BUCKET_CHIP: Record<string, string> = {
  AVAILABLE: 'chip ok',
  DAMAGED_HOLD: 'chip bad',
  UNDER_REPAIR: 'chip warn',
  WRITTEN_OFF: 'chip',
};

export function AssetRegister({ granted }: { granted: string[] }) {
  const session = useSession();
  const [siteId, setSiteId] = useState('');
  const [bucket, setBucket] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [serialNo, setSerialNo] = useState('');

  const url = `/api/assets${qs({ site_id: siteId, bucket, search })}`;
  const { data, loading, error, reload } = useResource<Asset[]>(url, [siteId, bucket, search]);
  const drift = useResource<Drift[]>(`/api/assets/drift${qs({ site_id: siteId })}`, [siteId]);

  const save = useMutation(
    async (id: number) => api.patch(`/api/assets/${id}`, { serial_no: serialNo || null }),
    { onDone: () => { setEditing(null); reload(); } },
  );

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      available: rows.filter(a => a.bucket === 'AVAILABLE').length,
      inWarranty: rows.filter(a => a.in_warranty).length,
      noSerial: rows.filter(a => !a.serial_no).length,
    };
  }, [data]);

  const canEdit = granted.includes('ASSET.EDIT');
  const sites = session.data?.sites ?? [];

  return (
    <>
      <Kpis>
        <Kpi label="Units" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Available" value={counts.available} hint="On the shelf" tone="ok" />
        <Kpi label="Under warranty" value={counts.inWarranty} hint="Claimable if damaged" />
        <Kpi label="No serial recorded" value={counts.noSerial} hint="Worth capturing" tone={counts.noSerial ? 'warn' : undefined} />
      </Kpis>

      {(drift.data?.length ?? 0) > 0 && (
        <Banner kind="bad">
          The unit count and the stock balance disagree on{' '}
          {drift.data?.map(d => `${d.itemCode} at ${d.siteName} (${d.unitCount} units vs ${fmtQty(d.balanceQty)} ${d.bucket.toLowerCase().replace(/_/g, ' ')})`).join('; ')}
          . This is reported rather than corrected automatically — which figure is right is a question for
          the warehouse, not the database.
        </Banner>
      )}

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor="as-search">Search by tag, serial or item</label>
          <input id="as-search" className="inp" value={search} onChange={e => setSearch(e.target.value)} placeholder="DL-TEMP-01" />
        </div>

        <div className="field" style={{ minWidth: 170 }}>
          <label htmlFor="as-site">Site</label>
          <select id="as-site" className="inp" value={siteId} onChange={e => setSiteId(e.target.value)}>
            <option value="">Every site I can see</option>
            {sites.map(s => (
              <option key={s.siteId} value={s.siteId}>{s.siteName}</option>
            ))}
          </select>
        </div>

        <div className="field" style={{ minWidth: 170 }}>
          <label htmlFor="as-bucket">State</label>
          <select id="as-bucket" className="inp" value={bucket} onChange={e => setBucket(e.target.value)}>
            <option value="">Any state</option>
            {ENUMS.stock_bucket.map(b => (
              <option key={b} value={b}>{b.replace(/_/g, ' ').toLowerCase()}</option>
            ))}
          </select>
        </div>
      </section>

      {loading && <LoadingState rows={6} label="Loading the asset register" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState title={search || siteId || bucket ? 'Nothing matches that' : 'No serialised units yet'}>
          Units are created automatically when a goods receipt for a serialised item is approved. Mark an
          item as serialised in master data for its receipts to appear here.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card
          title="Units"
          subtitle="The state follows the stock ledger and is not editable here."
          label="Asset register"
        >
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Tag</div>
              <div>Item and origin</div>
              <div>Serial</div>
              <div>State</div>
              <div>Warranty</div>
            </div>
            {(data ?? []).map(a => (
              <div key={a.id} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">
                  {a.asset_tag}
                  <div className="sub">{a.site_name}{a.location_code && ` · ${a.location_code}`}</div>
                </div>
                <div>
                  <span className="mono">{a.item_code}</span>
                  <div className="sub">
                    {a.item_name}
                    {a.grn_no && ` · ${a.grn_no}`}
                    {a.vendor_name && ` · ${a.vendor_name}`}
                  </div>
                </div>
                <div>
                  {editing === a.id ? (
                    <form
                      onSubmit={e => {
                        e.preventDefault();
                        void save.run(a.id);
                      }}
                    >
                      <label htmlFor={`as-sn-${a.id}`} className="sr-only">Serial number for {a.asset_tag}</label>
                      <input
                        id={`as-sn-${a.id}`}
                        className="inp"
                        value={serialNo}
                        onChange={e => setSerialNo(e.target.value)}
                        maxLength={120}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <button type="submit" className="btn btn-sm btn-primary" disabled={save.busy}>Save</button>
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <span className="mono">{a.serial_no ?? <span className="sub">not recorded</span>}</span>
                      {canEdit && (
                        <div>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => { setEditing(a.id); setSerialNo(a.serial_no ?? ''); }}
                          >
                            {a.serial_no ? 'Change' : 'Add'}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div>
                  <span className={BUCKET_CHIP[a.bucket] ?? 'chip'}>
                    {a.bucket.replace(/_/g, ' ').toLowerCase()}
                  </span>
                </div>
                <div className="sub">
                  {a.warranty_until ? (
                    <>
                      {fmtDate(a.warranty_until)}
                      <div>{a.in_warranty ? 'in warranty' : 'expired'}</div>
                    </>
                  ) : (
                    'none'
                  )}
                </div>
              </div>
            ))}
          </div>
          {save.error && <div className="pad"><Banner kind="bad">{save.error}</Banner></div>}
        </Card>
      )}
    </>
  );
}
