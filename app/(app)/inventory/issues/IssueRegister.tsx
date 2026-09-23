'use client';

/**
 * Stock issues — material leaving the warehouse for use.
 *
 * There is no approval chain and no draft state. An issue either happened or it
 * did not, which is why `stock_issues` has no status column and why every line
 * posts in one transaction: a half-issued receipt is not a thing the schema can
 * describe.
 *
 * Correcting one is a reversal in the ledger, not an edit here.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, fmtDateTime, fmtQty,
} from '@/components/ui';
import { useResource, useSession } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { NewIssueForm } from '@/app/(app)/inventory/issues/NewIssueForm';

interface Issue {
  id: number;
  issue_no: string;
  site_code: string;
  site_name: string;
  issued_to: string;
  issued_by_name: string;
  issued_at: string;
  line_count: string | number;
  total_qty: string;
}

const COLS = '160px 1fr 150px 100px 170px';

export function IssueRegister({ granted }: { granted: string[] }) {
  const session = useSession();
  const [siteId, setSiteId] = useState('');
  const [issuing, setIssuing] = useState(false);

  const url = `/api/issues${qs({ site_id: siteId })}`;
  const { data, loading, error, reload } = useResource<Issue[]>(url, [siteId]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      qty: rows.reduce((s, r) => s + Number(r.total_qty ?? 0), 0),
      today: rows.filter(r => new Date(r.issued_at).toDateString() === new Date().toDateString()).length,
    };
  }, [data]);

  const canIssue = granted.includes('INVENTORY.ISSUE');
  const sites = session.data?.sites ?? [];

  return (
    <>
      <Kpis>
        <Kpi label="Issues" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Issued today" value={counts.today} hint="Across the sites you hold" />
        <Kpi label="Quantity issued" value={fmtQty(counts.qty)} hint="Total across the list" />
      </Kpis>

      <section className="card pad" style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }} aria-label="Filters">
        <div className="field" style={{ minWidth: 180 }}>
          <label htmlFor="iss-site">Site</label>
          <select id="iss-site" className="inp" value={siteId} onChange={e => setSiteId(e.target.value)}>
            <option value="">Every site I can see</option>
            {sites.map(s => (
              <option key={s.siteId} value={s.siteId}>{s.siteName}</option>
            ))}
          </select>
        </div>

        {canIssue && !issuing && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setIssuing(true)}>
            Issue stock
          </button>
        )}
      </section>

      {issuing && (
        <NewIssueForm
          onClose={() => setIssuing(false)}
          onCreated={() => {
            setIssuing(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading issues" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={siteId ? 'No issues at that site' : 'Nothing has been issued yet'}
          action={
            canIssue ? (
              <button type="button" className="btn btn-primary" onClick={() => setIssuing(true)}>Issue stock</button>
            ) : (
              <Link className="btn" href="/inventory">See what is in stock</Link>
            )
          }
        >
          An issue records material leaving the warehouse for a department, a work order or a person. It
          posts straight to the ledger — there is nothing to approve.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Stock issues">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Issued to</div>
              <div>Site</div>
              <div className="r">Lines</div>
              <div>When and who</div>
            </div>
            {(data ?? []).map(i => (
              <Link key={i.id} href={`/inventory/issues/${i.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">{i.issue_no}</div>
                <div>{i.issued_to}</div>
                <div className="sub">{i.site_name}</div>
                <div className="r">
                  {fmtQty(i.line_count)}
                  <div className="sub">{fmtQty(i.total_qty)} total</div>
                </div>
                <div className="sub">
                  {fmtDateTime(i.issued_at)}
                  <div>{i.issued_by_name}</div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
