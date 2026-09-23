'use client';

/**
 * Report damage.
 *
 * There is no "estimated value" field for stock the system can value. The
 * figure comes from the rate the item was actually received at, because it
 * decides whether a later write-off needs an insurance reference — and a number
 * the reporter chooses is a number they can choose to keep under the threshold.
 * The field appears only for stock that has never been received here.
 *
 * A serialised item is damaged as a unit, not as a quantity, so the form asks
 * for the tag instead.
 */
import { useEffect, useMemo, useState } from 'react';
import { Banner, Card, FieldError, fmtQty } from '@/components/ui';
import { api, qs } from '@/lib/client/api';
import { useMutation, useResource, useSession } from '@/lib/client/use-resource';
import { ENUMS } from '@/lib/enums';

interface Position {
  item_id: number;
  code: string;
  name: string;
  uom: string;
  available: string;
  is_serialised: boolean;
}

interface Asset {
  id: number;
  asset_tag: string;
  serial_no: string | null;
  item_code: string;
}

export function ReportDamageForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const session = useSession();
  const sites = useMemo(() => session.data?.sites ?? [], [session.data]);

  const [siteId, setSiteId] = useState('');
  const [itemId, setItemId] = useState('');
  const [assetUnitId, setAssetUnitId] = useState('');
  const [qty, setQty] = useState('');
  const [cause, setCause] = useState('');
  const [observedOn, setObservedOn] = useState(new Date().toISOString().slice(0, 10));
  const [estimatedValue, setEstimatedValue] = useState('');

  useEffect(() => {
    if (!siteId && sites.length > 0) setSiteId(String(sites[0].siteId));
  }, [sites, siteId]);

  const stock = useResource<Position[]>(siteId ? `/api/inventory${qs({ site_id: siteId })}` : null, [siteId]);
  const item = stock.data?.find(p => String(p.item_id) === itemId);

  const units = useResource<Asset[]>(
    item?.is_serialised && siteId ? `/api/assets${qs({ site_id: siteId, item_id: itemId, bucket: 'AVAILABLE' })}` : null,
    [siteId, itemId, item?.is_serialised],
  );

  const report = useMutation(
    async () =>
      api.post('/api/damage', {
        site_id: Number(siteId),
        item_id: Number(itemId),
        qty: item?.is_serialised ? '1' : qty,
        cause,
        observed_on: observedOn,
        asset_unit_id: assetUnitId ? Number(assetUnitId) : null,
        estimated_value: estimatedValue || null,
      }),
    { onDone: onCreated, successMessage: 'Reported and quarantined.' },
  );

  const err = (field: string) => (report.fieldError?.field === field ? report.fieldError.message : null);
  const over = item !== undefined && qty !== '' && Number(qty) > Number(item.available);

  const ready =
    siteId !== '' && itemId !== '' && cause !== '' &&
    (item?.is_serialised ? assetUnitId !== '' : qty !== '' && !over);

  return (
    <Card
      title="Report damage"
      label="Report damage"
      right={<button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>}
    >
      <form
        className="pad"
        onSubmit={e => {
          e.preventDefault();
          void report.run(undefined);
        }}
      >
        {report.error && <Banner kind="bad">{report.error}</Banner>}

        <Banner kind="warn">
          Reporting this quarantines the stock immediately — it leaves the available pool now, not when
          somebody decides what to do about it.
        </Banner>

        <div className="grid g3">
          <div className="field">
            <label htmlFor="dm-site">Site</label>
            <select
              id="dm-site"
              className="inp"
              value={siteId}
              onChange={e => { setSiteId(e.target.value); setItemId(''); setAssetUnitId(''); }}
              required
            >
              {sites.map(s => (
                <option key={s.siteId} value={s.siteId}>{s.siteName}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="dm-item">Item</label>
            <select
              id="dm-item"
              className="inp"
              value={itemId}
              onChange={e => { setItemId(e.target.value); setAssetUnitId(''); setQty(''); }}
              required
            >
              <option value="">Choose an item…</option>
              {(stock.data ?? [])
                .filter(p => Number(p.available) > 0)
                .map(p => (
                  <option key={p.item_id} value={p.item_id}>
                    {p.code} — {p.name}
                  </option>
                ))}
            </select>
            {err('item_id') && <FieldError id="dm-item">{err('item_id')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="dm-observed">Observed on</label>
            <input
              id="dm-observed"
              className="inp"
              type="date"
              value={observedOn}
              max={new Date().toISOString().slice(0, 10)}
              onChange={e => setObservedOn(e.target.value)}
              required
            />
            <span className="sub">Whether it was in warranty is judged against this date.</span>
          </div>
        </div>

        <div className="grid g3">
          {item?.is_serialised ? (
            <div className="field">
              <label htmlFor="dm-unit">Which unit?</label>
              <select id="dm-unit" className="inp" value={assetUnitId} onChange={e => setAssetUnitId(e.target.value)} required>
                <option value="">Choose a unit…</option>
                {(units.data ?? []).map(u => (
                  <option key={u.id} value={u.id}>
                    {u.asset_tag}{u.serial_no ? ` — ${u.serial_no}` : ''}
                  </option>
                ))}
              </select>
              <span className="sub">This item is serialised, so damage is recorded against the unit.</span>
              {err('asset_unit_id') && <FieldError id="dm-unit">{err('asset_unit_id')}</FieldError>}
            </div>
          ) : (
            <div className="field">
              <label htmlFor="dm-qty">How much?</label>
              <input
                id="dm-qty"
                className="inp"
                inputMode="decimal"
                value={qty}
                onChange={e => setQty(e.target.value)}
                aria-invalid={over || undefined}
                required
                disabled={!itemId}
              />
              {item && (
                <span className="sub">
                  {fmtQty(item.available)} {item.uom} available
                  {over && <strong> — more than that cannot be quarantined</strong>}
                </span>
              )}
              {err('qty') && <FieldError id="dm-qty">{err('qty')}</FieldError>}
            </div>
          )}

          <div className="field">
            <label htmlFor="dm-cause">Cause</label>
            <select id="dm-cause" className="inp" value={cause} onChange={e => setCause(e.target.value)} required>
              <option value="">Choose…</option>
              {ENUMS.damage_cause.map(c => (
                <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="dm-value">Estimated value (₹)</label>
            <input
              id="dm-value"
              className="inp"
              inputMode="decimal"
              value={estimatedValue}
              onChange={e => setEstimatedValue(e.target.value)}
              placeholder="Worked out automatically"
            />
            <span className="sub">
              Leave blank. It is calculated from what this item was last received for, and is only asked
              for when there is no receipt to price it from.
            </span>
            {err('estimated_value') && <FieldError id="dm-value">{err('estimated_value')}</FieldError>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={report.busy || !ready}>
            {report.busy ? 'Reporting…' : 'Report and quarantine'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>

        <p className="sub" style={{ marginBottom: 0 }}>
          A Site Manager and a QC inspector both have to look at it before anything else happens. Neither
          can be you.
        </p>
      </form>
    </Card>
  );
}
