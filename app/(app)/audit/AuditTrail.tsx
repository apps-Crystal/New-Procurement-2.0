'use client';

/**
 * The audit trail.
 *
 * `audit_log` is append-only with a `forbid_mutation()` trigger, so this screen
 * reads and offers nothing that writes. There is no edit, no delete, and no
 * bulk action — that absence is the feature.
 *
 * Overrides get their own filter and their own colour. They are the rows that
 * matter: somebody accepted material that failed inspection, wrote off stock,
 * took a short credit note, or reopened a signed-off reconciliation. Buried
 * among thousands of ordinary transitions they would not be a control at all.
 *
 * The filter chips are built from what the trail actually contains rather than
 * from a hardcoded list, so a new entity type appears the moment something
 * writes one.
 */
import { useMemo, useState } from 'react';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, fmtDateTime,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';

interface Entry {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  from_status: string | null;
  to_status: string | null;
  before_data: unknown;
  after_data: unknown;
  user_name: string | null;
  user_email: string | null;
  ip_address: string | null;
  remarks: string | null;
  created_at: string;
}

interface Summary {
  entityTypes: { entity_type: string; n: number }[];
  actions: { action: string; n: number }[];
  overrides: number;
  total: number;
}

const COLS = '80px 170px 150px 1fr 170px';

/** How each action reads, and how loudly. */
const ACTION_STYLE: Record<string, string> = {
  OVERRIDE: 'chip bad',
  REJECTED_ATTEMPT: 'chip bad',
  PERMISSION_CHANGE: 'chip warn',
  DELETE: 'chip warn',
  TRANSITION: 'chip',
  CREATE: 'chip ok',
  UPDATE: 'chip',
};

/** Where an entity's own screen lives, for the entries that have one. */
const SCREEN: Record<string, (id: number) => string> = {
  MR: id => `/mr/${id}`,
  TRANSFER: id => `/transfers/${id}`,
  PR: id => `/pr/${id}`,
  PO: id => `/po/${id}`,
  GATE_INWARD: id => `/gate-inward/${id}`,
  GRN: id => `/grn/${id}`,
  DAMAGE: id => `/damage/${id}`,
  RTV: id => `/returns/${id}`,
  INVOICE: id => `/invoices/${id}`,
  DEBIT_NOTE: id => `/notes/${id}`,
  RECON: id => `/reconciliation/${id}`,
  VENDOR: id => `/vendors/${id}`,
};

export function AuditTrail() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const url = `/api/audit${qs({ entity_type: entityType, action, search })}`;
  const { data, loading, error, reload } = useResource<Entry[]>(url, [entityType, action, search]);
  const summary = useResource<Summary>('/api/audit/summary');

  const filtered = entityType !== '' || action !== '' || search !== '';

  const shownOverrides = useMemo(
    () => (data ?? []).filter(e => e.action === 'OVERRIDE').length,
    [data],
  );

  return (
    <>
      <Kpis>
        <Kpi label="Entries" value={summary.data?.total ?? '—'} hint="Everything ever recorded" />
        <Kpi
          label="Overrides"
          value={summary.data?.overrides ?? '—'}
          hint="Somebody set a rule aside"
          tone={(summary.data?.overrides ?? 0) > 0 ? 'warn' : 'ok'}
        />
        <Kpi label="Shown" value={data?.length ?? '—'} hint="Matching the current filter, newest first" />
        <Kpi label="Overrides shown" value={shownOverrides} hint="Within the current filter" />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field" style={{ minWidth: 240 }}>
          <label htmlFor="au-search">Search remarks, entity or person</label>
          <input id="au-search" className="inp" value={search} onChange={e => setSearch(e.target.value)} placeholder="concession" />
        </div>

        <div className="field" style={{ minWidth: 190 }}>
          <label htmlFor="au-entity">Entity</label>
          <select id="au-entity" className="inp" value={entityType} onChange={e => setEntityType(e.target.value)}>
            <option value="">Everything</option>
            {(summary.data?.entityTypes ?? []).map(t => (
              <option key={t.entity_type} value={t.entity_type}>
                {t.entity_type.replace(/_/g, ' ').toLowerCase()} ({t.n})
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ minWidth: 190 }}>
          <label htmlFor="au-action">Action</label>
          <select id="au-action" className="inp" value={action} onChange={e => setAction(e.target.value)}>
            <option value="">Any action</option>
            {(summary.data?.actions ?? []).map(a => (
              <option key={a.action} value={a.action}>
                {a.action.replace(/_/g, ' ').toLowerCase()} ({a.n})
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="btn btn-sm"
          aria-pressed={action === 'OVERRIDE'}
          onClick={() => setAction(action === 'OVERRIDE' ? '' : 'OVERRIDE')}
        >
          Overrides only
        </button>

        {filtered && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => { setEntityType(''); setAction(''); setSearch(''); }}
          >
            Clear
          </button>
        )}
      </section>

      {loading && <LoadingState rows={8} label="Loading the audit trail" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={filtered ? 'Nothing matches that' : 'The trail is empty'}
          action={
            filtered ? (
              <button type="button" className="btn" onClick={() => { setEntityType(''); setAction(''); setSearch(''); }}>
                Clear filters
              </button>
            ) : null
          }
        >
          Every state change, override and refused attempt in the system is written here, inside the
          transaction that made it. Nothing can edit or remove an entry.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card
          title="Entries"
          subtitle="Append-only. Newest first, capped at 200 — narrow the filters to see further back."
          label="Audit trail"
        >
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Action</div>
              <div>Entity</div>
              <div>Change</div>
              <div>Who and why</div>
              <div>When</div>
            </div>
            {(data ?? []).map(e => {
              const screen = SCREEN[e.entity_type]?.(e.entity_id);
              const open = expanded === e.id;

              return (
                <div key={e.id}>
                  <div
                    className="tr"
                    style={{
                      gridTemplateColumns: COLS,
                      cursor: 'pointer',
                      ...(e.action === 'OVERRIDE' ? { background: 'var(--surface-2)' } : {}),
                    }}
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : e.id)}
                    onKeyDown={ev => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        setExpanded(open ? null : e.id);
                      }
                    }}
                  >
                    <div>
                      <span className={ACTION_STYLE[e.action] ?? 'chip'}>
                        {e.action.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    </div>
                    <div>
                      <span className="mono">{e.entity_type}</span>
                      <div className="sub">
                        {screen ? (
                          <a href={screen} onClick={ev => ev.stopPropagation()}>#{e.entity_id}</a>
                        ) : (
                          `#${e.entity_id}`
                        )}
                      </div>
                    </div>
                    <div className="sub">
                      {e.from_status || e.to_status ? (
                        <>
                          {e.from_status ?? '—'} → <strong>{e.to_status ?? '—'}</strong>
                        </>
                      ) : (
                        '—'
                      )}
                    </div>
                    <div>
                      {e.user_name ?? <span className="sub">system</span>}
                      {e.remarks && <div className="sub">{e.remarks}</div>}
                    </div>
                    <div className="sub">
                      {fmtDateTime(e.created_at)}
                      {e.ip_address && <div className="mono">{e.ip_address}</div>}
                    </div>
                  </div>

                  {open && (
                    <div className="pad" style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--line-2)' }}>
                      <div className="grid g2">
                        <div>
                          <span className="lbl">Before</span>
                          <pre className="sub" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {e.before_data ? JSON.stringify(e.before_data, null, 2) : 'nothing recorded'}
                          </pre>
                        </div>
                        <div>
                          <span className="lbl">After</span>
                          <pre className="sub" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {e.after_data ? JSON.stringify(e.after_data, null, 2) : 'nothing recorded'}
                          </pre>
                        </div>
                      </div>
                      {e.user_email && (
                        <div className="sub" style={{ marginTop: 10 }}>
                          Recorded against {e.user_email}
                          {e.ip_address && ` from ${e.ip_address}`}.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}
