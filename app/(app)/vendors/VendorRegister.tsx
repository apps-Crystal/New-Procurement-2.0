'use client';

/**
 * Vendor register.
 *
 * Follows the prototype's list conventions: a filter card, a grid table with
 * `.tr`/`.th`, status chips, and a mono column for codes. The six states the
 * brief requires (§25) are all present — the prototype had none of them, since
 * it rendered from a JavaScript object with nothing to fail.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Kpi,
  Kpis,
  LoadingState,
  StatusChip,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { stateName } from '@/lib/validate';
import { NewVendorForm } from '@/app/(app)/vendors/NewVendorForm';

interface Vendor {
  id: number;
  vendor_code: string;
  legal_name: string;
  pan: string;
  gstin: string | null;
  state_code: string;
  status: string;
  tally_ledger_ref: string | null;
  blocked_reason: string | null;
}

const COLS = '110px 1.8fr 130px 160px 1fr 150px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'VENDOR_DRAFT' },
  { label: 'Pending', value: 'VENDOR_PENDING' },
  { label: 'Approved', value: 'VENDOR_APPROVED' },
  { label: 'Blocked', value: 'VENDOR_BLOCKED' },
];

export function VendorRegister({ granted }: { granted: string[] }) {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const url = `/api/vendors${qs({ status, search })}`;
  const { data, loading, error, reload } = useResource<Vendor[]>(url, [status, search]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      pending: rows.filter(v => v.status === 'VENDOR_PENDING').length,
      approved: rows.filter(v => v.status === 'VENDOR_APPROVED').length,
      blocked: rows.filter(v => v.status === 'VENDOR_BLOCKED').length,
    };
  }, [data]);

  const canCreate = granted.includes('VENDOR.CREATE');

  return (
    <>
      <Kpis>
        <Kpi label="Vendors" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Awaiting approval" value={counts.pending} hint="Need a second pair of eyes" tone={counts.pending ? 'warn' : undefined} />
        <Kpi label="Approved" value={counts.approved} hint="Can be ordered from" tone="ok" />
        <Kpi label="Blocked" value={counts.blocked} hint="Cannot appear on a PO" tone={counts.blocked ? 'bad' : undefined} />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field" style={{ minWidth: 260 }}>
          <label htmlFor="v-search">Search by name, code, PAN or GSTIN</label>
          <input
            id="v-search"
            className="inp"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Northern Polymers"
          />
        </div>

        <div className="field">
          <span className="lbl">Status</span>
          <div className="seg" role="radiogroup" aria-label="Status">
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

        {canCreate && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            Add vendor
          </button>
        )}
      </section>

      {creating && (
        <NewVendorForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading vendors" />}

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
        <EmptyState
          title={search || status ? 'No vendors match that' : 'No vendors yet'}
          action={
            search || status ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSearch('');
                  setStatus('');
                }}
              >
                Clear filters
              </button>
            ) : canCreate ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Add the first vendor
              </button>
            ) : null
          }
        >
          {search || status
            ? 'Try a different search, or clear the filters to see every vendor.'
            : 'Vendors are added here, then approved by a second person before they can appear on a purchase order.'}
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Vendors">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Code</div>
              <div>Legal name</div>
              <div>PAN</div>
              <div>GSTIN</div>
              <div>State</div>
              <div>Status</div>
            </div>
            {data!.map(v => (
              <Link
                key={v.id}
                href={`/vendors/${v.id}`}
                className="tr"
                style={{ gridTemplateColumns: COLS, textDecoration: 'none', color: 'inherit' }}
              >
                <div className="mono" style={{ fontSize: 12 }}>{v.vendor_code}</div>
                <div>
                  <div className="b">{v.legal_name}</div>
                  {v.status === 'VENDOR_BLOCKED' && v.blocked_reason && (
                    <div className="sub t-bad">{v.blocked_reason}</div>
                  )}
                  {v.status === 'VENDOR_APPROVED' && !v.tally_ledger_ref && (
                    <div className="sub t-warn">No Tally ledger reference</div>
                  )}
                </div>
                <div className="mono" style={{ fontSize: 12 }}>{v.pan}</div>
                <div className="mono" style={{ fontSize: 12 }}>
                  {v.gstin ?? <span className="t-muted">Unregistered</span>}
                </div>
                <div className="sub">{stateName(v.state_code)}</div>
                <div>
                  <StatusChip status={v.status} />
                </div>
              </Link>
            ))}
          </div>
          <p className="sub" style={{ padding: '12px 18px', margin: 0 }}>
            Only approved vendors can be selected on a purchase order. Blocking a vendor takes effect immediately on
            every site.
          </p>
        </Card>
      )}

      {!granted.includes('VENDOR.BANK_VIEW') && (data?.length ?? 0) > 0 && (
        <div className="banner neutral">
          <span>
            Bank details are hidden from your role. Accounts and Finance can see the last four digits and propose
            changes. <Chip kind="neutral">VENDOR.BANK_VIEW</Chip>
          </span>
        </div>
      )}
    </>
  );
}
