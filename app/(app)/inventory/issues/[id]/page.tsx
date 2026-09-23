import Link from 'next/link';
import { Card, EmptyState, PageHead, Tile, fmtDateTime, fmtQty } from '@/components/ui';
import { getIssue } from '@/lib/services/issues';

export const dynamic = 'force-dynamic';

/**
 * A stock issue, rendered on the server.
 *
 * There is nothing to do on this screen — an issue has no actions, no status
 * and no edit — so it needs no client component and no loading state. It is a
 * record of something that already happened.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: Awaited<ReturnType<typeof getIssue>>;
  try {
    data = await getIssue(Number(id));
  } catch {
    return (
      <>
        <PageHead crumb="Inventory / Stock issues" title="Stock issue" />
        <EmptyState title="That issue no longer exists" action={<Link className="btn" href="/inventory/issues">Back to issues</Link>} />
      </>
    );
  }

  const { issue, lines } = data;
  const total = lines.reduce((s, l) => s + Number(l.qty), 0);

  return (
    <>
      <PageHead crumb="Inventory / Stock issues" title="Stock issue" />

      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2><span className="mono">{String(issue.issue_no)}</span></h2>
            <span className="sub">
              Issued to {String(issue.issued_to)} from {String(issue.site_name)}
            </span>
          </div>
        </div>

        <div className="pad grid g3">
          <Tile label="Issued by" value={String(issue.issued_by_name)} />
          <Tile label="When" value={fmtDateTime(issue.issued_at as string)} />
          <Tile label="Quantity" value={fmtQty(total)} hint={`${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`} />
        </div>
      </Card>

      <Card title="What went out" label="Lines">
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: '1fr 130px 140px 170px' }}>
            <div>Item</div>
            <div className="r">Quantity</div>
            <div>Location</div>
            <div>Ledger entry</div>
          </div>
          {lines.map(l => (
            <div key={String(l.id)} className="tr" style={{ gridTemplateColumns: '1fr 130px 140px 170px' }}>
              <div>
                <span className="mono">{String(l.item_code)}</span>
                <div className="sub">{String(l.item_name)}</div>
              </div>
              <div className="r">
                {fmtQty(l.qty as string)} <span className="sub">{String(l.uom)}</span>
              </div>
              <div className="sub">{(l.location_code as string) ?? '—'}</div>
              <div className="mono sub">
                {(l.entry_no as string) ?? '—'}
                {l.is_reversed === true && <div><strong>reversed</strong></div>}
              </div>
            </div>
          ))}
        </div>
        <div className="pad sub" style={{ borderTop: '1px solid var(--line-2)' }}>
          An issue cannot be edited. If one of these was wrong, reverse its ledger entry from the{' '}
          <Link href="/inventory/ledger">stock ledger</Link> — the original stays visible beside the
          correction.
        </div>
      </Card>
    </>
  );
}
