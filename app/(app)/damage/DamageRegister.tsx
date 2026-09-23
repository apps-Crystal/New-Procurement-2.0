'use client';

/**
 * Damaged and missing stock.
 *
 * Reporting damage quarantines it in the same breath — the movement
 * AVAILABLE → DAMAGED_HOLD posts with the report, not after somebody decides
 * what to do about it. That ordering is the whole point: damaged stock that is
 * still issuable while a decision is pending is how damaged stock reaches a
 * customer.
 *
 * What happens next — repair, warranty claim or write-off, and any return to
 * the vendor — is the next phase. This screen covers finding it, getting it out
 * of the way, and having two people look at it.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtMoney, fmtQty,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { ReportDamageForm } from '@/app/(app)/damage/ReportDamageForm';

interface DamageRow {
  id: number;
  dmg_no: string;
  status: string;
  site_name: string;
  item_code: string;
  item_name: string;
  uom: string;
  asset_tag: string | null;
  location_code: string | null;
  qty: string;
  cause: string;
  observed_on: string;
  estimated_value: string;
  in_warranty: boolean;
  reported_by_name: string;
  signature_count: string | number;
}

const COLS = '150px 1fr 130px 130px 130px 160px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Reported', value: 'DMG_REPORTED' },
  { label: 'Inspected', value: 'DMG_INSPECTED' },
  { label: 'Closed', value: 'DMG_CLOSED' },
];

export function DamageRegister({ granted }: { granted: string[]; userId: number }) {
  const [status, setStatus] = useState('');
  const [reporting, setReporting] = useState(false);

  const url = `/api/damage${qs({ status })}`;
  const { data, loading, error, reload } = useResource<DamageRow[]>(url, [status]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      awaiting: rows.filter(d => d.status === 'DMG_REPORTED').length,
      value: rows.reduce((s, d) => s + Number(d.estimated_value ?? 0), 0),
      inWarranty: rows.filter(d => d.in_warranty).length,
    };
  }, [data]);

  const canReport = granted.includes('DAMAGE.CREATE');

  return (
    <>
      <Kpis>
        <Kpi label="Reports" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Awaiting inspection" value={counts.awaiting} hint="Needs a Site Manager and QC" tone={counts.awaiting ? 'warn' : undefined} />
        <Kpi label="Value quarantined" value={`₹${fmtMoney(counts.value)}`} hint="At the rate it was received for" />
        <Kpi label="Under warranty" value={counts.inWarranty} hint="A claim may be possible" tone={counts.inWarranty ? 'info' : undefined} />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field">
          <span className="lbl">Stage</span>
          <div className="seg" role="radiogroup" aria-label="Stage">
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

        {canReport && !reporting && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setReporting(true)}>
            Report damage
          </button>
        )}
      </section>

      {reporting && (
        <ReportDamageForm
          onClose={() => setReporting(false)}
          onCreated={() => {
            setReporting(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading damage reports" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status ? 'Nothing matches that' : 'Nothing has been reported'}
          action={
            status ? (
              <button type="button" className="btn" onClick={() => setStatus('')}>Clear filter</button>
            ) : canReport ? (
              <button type="button" className="btn btn-primary" onClick={() => setReporting(true)}>Report damage</button>
            ) : (
              <Link className="btn" href="/inventory">See what is in stock</Link>
            )
          }
        >
          Reporting damage takes the stock out of the available pool straight away, so it cannot be issued
          while anyone decides what to do with it.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Damage reports">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Item and cause</div>
              <div className="r">Quantity</div>
              <div className="r">Value</div>
              <div>Observed</div>
              <div>Stage</div>
            </div>
            {(data ?? []).map(d => (
              <Link key={d.id} href={`/damage/${d.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">{d.dmg_no}</div>
                <div>
                  <span className="mono">{d.item_code}</span>
                  <div className="sub">
                    {d.cause.replace(/_/g, ' ').toLowerCase()} · {d.site_name}
                    {d.location_code && ` · ${d.location_code}`}
                    {d.asset_tag && ` · ${d.asset_tag}`}
                  </div>
                </div>
                <div className="r">
                  {fmtQty(d.qty)} <span className="sub">{d.uom}</span>
                </div>
                <div className="r">
                  ₹{fmtMoney(d.estimated_value)}
                  {d.in_warranty && <div className="sub">in warranty</div>}
                </div>
                <div className="sub">
                  {fmtDate(d.observed_on)}
                  <div>{d.reported_by_name}</div>
                </div>
                <div>
                  <StatusChip status={d.status} />
                  {d.status === 'DMG_REPORTED' && (
                    <div className="sub">{Number(d.signature_count)} of 2 signed</div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
