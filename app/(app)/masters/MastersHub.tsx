'use client';

/**
 * Master data hub.
 *
 * One screen with a segmented switch rather than eight near-identical pages.
 * The prototype had no master-data screens at all, so this follows its
 * conventions — filter card, grid table, status chips — rather than inventing a
 * new pattern for them.
 */
import { useState } from 'react';
import { Card, EmptyState, ErrorState, LoadingState, StatusChip, fmtQty } from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { stateName } from '@/lib/validate';
import { label, CATEGORY_LABELS, SITE_TYPE_LABELS } from '@/lib/labels';
import { NewSiteForm } from '@/app/(app)/masters/NewSiteForm';
import { NewItemForm } from '@/app/(app)/masters/NewItemForm';

type TabKey = 'sites' | 'item-classes' | 'items' | 'budget-codes' | 'locations';

interface TabDef {
  key: TabKey;
  label: string;
  url: string;
  /** Permission that reveals the "add" action. Viewing is MASTER.VIEW. */
  manage: string;
}

const TABS: TabDef[] = [
  { key: 'sites', label: 'Sites', url: '/api/master/sites', manage: 'MASTER.SITE_MANAGE' },
  { key: 'locations', label: 'Storage locations', url: '/api/master/locations', manage: 'MASTER.LOCATION_MANAGE' },
  { key: 'item-classes', label: 'Item classes', url: '/api/master/item-classes', manage: 'MASTER.ITEM_MANAGE' },
  { key: 'items', label: 'Items', url: '/api/master/items', manage: 'MASTER.ITEM_MANAGE' },
  { key: 'budget-codes', label: 'Budget codes', url: '/api/master/budget-codes', manage: 'MASTER.BUDGET_MANAGE' },
];

export function MastersHub({ granted }: { granted: string[] }) {
  const [active, setActive] = useState<TabKey>('sites');
  const [adding, setAdding] = useState(false);

  const tab = TABS.find(t => t.key === active)!;
  const { data, loading, error, reload } = useResource<Record<string, unknown>[]>(tab.url, [active]);

  const canManage = granted.includes(tab.manage);
  const canAdd = canManage && (active === 'sites' || active === 'items');

  return (
    <>
      <div className="seg" role="tablist" aria-label="Master data">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            className="btn"
            aria-selected={active === t.key}
            aria-pressed={active === t.key}
            onClick={() => {
              setActive(t.key);
              setAdding(false);
            }}
          >
            {t.label}
          </button>
        ))}
        {canAdd && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setAdding(v => !v)}>
            Add {active === 'sites' ? 'site' : 'item'}
          </button>
        )}
      </div>

      {adding && active === 'sites' && (
        <NewSiteForm
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {adding && active === 'items' && (
        <NewItemForm
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label={`Loading ${tab.label.toLowerCase()}`} />}

      {!loading && error && (
        <ErrorState
          message={error}
          retry={
            <button type="button" className="btn" onClick={reload}>
              Try again
            </button>
          }
        />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState title={`No ${tab.label.toLowerCase()} yet`}>
          {active === 'sites'
            ? 'Every record in Procurement belongs to a site, so this is the first thing to set up.'
            : active === 'items'
              ? 'Items need an item class first — that is what carries the cold-chain band and the QC checklist.'
              : 'Nothing has been added here yet.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label={tab.label}>
          <Table tab={active} rows={data!} />
        </Card>
      )}

      {!canManage && (
        <p className="sub" style={{ margin: 0 }}>
          You can view this list. Changing it needs {tab.manage.replace('MASTER.', '').replace(/_/g, ' ').toLowerCase()}.
        </p>
      )}
    </>
  );
}

function Table({ tab, rows }: { tab: TabKey; rows: Record<string, unknown>[] }) {
  if (tab === 'sites') {
    const cols = '90px 1.6fr 130px 150px 1fr 110px';
    return (
      <div className="tbl">
        <div className="tr th" style={{ gridTemplateColumns: cols }}>
          <div>Code</div>
          <div>Name</div>
          <div>Type</div>
          <div>GSTIN</div>
          <div>Tally cost centre</div>
          <div>Status</div>
        </div>
        {rows.map(r => (
          <div className="tr" style={{ gridTemplateColumns: cols }} key={String(r.id)}>
            <div className="mono b" style={{ fontSize: 12 }}>{String(r.code)}</div>
            <div>
              <div className="b">{String(r.name)}</div>
              <div className="sub">{stateName(String(r.state_code))}</div>
            </div>
            <div className="sub">
              {label(SITE_TYPE_LABELS, String(r.site_type))}
              {r.cold_chain_capable === true && <div className="sub t-info">Cold chain</div>}
            </div>
            <div className="mono" style={{ fontSize: 12 }}>{String(r.gstin)}</div>
            <div className="mono sub">
              {r.tally_cost_centre ? String(r.tally_cost_centre) : <span className="t-warn">Not mapped</span>}
            </div>
            <div><StatusChip status={String(r.status)} /></div>
          </div>
        ))}
      </div>
    );
  }

  if (tab === 'items') {
    const cols = '140px 1.8fr 80px 110px 90px 110px';
    return (
      <div className="tbl">
        <div className="tr th" style={{ gridTemplateColumns: cols }}>
          <div>Code</div>
          <div>Name</div>
          <div>UOM</div>
          <div className="r">GST</div>
          <div>Serialised</div>
          <div>Status</div>
        </div>
        {rows.map(r => (
          <div className="tr" style={{ gridTemplateColumns: cols }} key={String(r.id)}>
            <div className="mono" style={{ fontSize: 12 }}>{String(r.code)}</div>
            <div className="b">{String(r.name)}</div>
            <div className="sub">{String(r.uom)}</div>
            <div className="r mono">{fmtQty(r.default_gst_rate as string)}%</div>
            <div className="sub">{r.is_serialised === true ? 'Yes · asset tags' : '—'}</div>
            <div><StatusChip status={String(r.status)} /></div>
          </div>
        ))}
      </div>
    );
  }

  if (tab === 'item-classes') {
    const cols = '120px 1.6fr 140px 1fr';
    return (
      <div className="tbl">
        <div className="tr th" style={{ gridTemplateColumns: cols }}>
          <div>Code</div>
          <div>Name</div>
          <div>Cold chain</div>
          <div>Temperature band</div>
        </div>
        {rows.map(r => (
          <div className="tr" style={{ gridTemplateColumns: cols }} key={String(r.id)}>
            <div className="mono b" style={{ fontSize: 12 }}>{String(r.code)}</div>
            <div className="b">{String(r.name)}</div>
            <div>
              {r.is_cold_chain === true ? <StatusChip status="ACTIVE" /> : <span className="t-muted">Ambient</span>}
            </div>
            <div className="mono sub">
              {r.is_cold_chain === true ? `${r.temp_min_c} to ${r.temp_max_c} °C` : '—'}
              {r.requires_data_logger === true && <div className="sub t-info">Data logger required</div>}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (tab === 'budget-codes') {
    const cols = '160px 120px 1fr 1.4fr 100px';
    return (
      <div className="tbl">
        <div className="tr th" style={{ gridTemplateColumns: cols }}>
          <div>Code</div>
          <div>Year</div>
          <div>Category</div>
          <div>Description</div>
          <div>Active</div>
        </div>
        {rows.map(r => (
          <div className="tr" style={{ gridTemplateColumns: cols }} key={String(r.id)}>
            <div className="mono b" style={{ fontSize: 12 }}>{String(r.code)}</div>
            <div className="mono sub">{String(r.financial_year)}</div>
            <div className="sub">{r.category ? label(CATEGORY_LABELS, String(r.category)) : 'Any'}</div>
            <div className="note">{r.description ? String(r.description) : '—'}</div>
            <div><StatusChip status={r.is_active === true ? 'ACTIVE' : 'INACTIVE'} /></div>
          </div>
        ))}
      </div>
    );
  }

  // Storage locations
  const cols = '120px 1.6fr 120px 110px';
  return (
    <div className="tbl">
      <div className="tr th" style={{ gridTemplateColumns: cols }}>
        <div>Code</div>
        <div>Description</div>
        <div>Cold</div>
        <div>Status</div>
      </div>
      {rows.map(r => (
        <div className="tr" style={{ gridTemplateColumns: cols }} key={String(r.id)}>
          <div className="mono b" style={{ fontSize: 12 }}>{String(r.code)}</div>
          <div className="note">{r.description ? String(r.description) : '—'}</div>
          <div className="sub">{r.is_cold === true ? 'Yes' : '—'}</div>
          <div><StatusChip status={String(r.status)} /></div>
        </div>
      ))}
    </div>
  );
}
