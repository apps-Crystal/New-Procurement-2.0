'use client';

/**
 * The dashboard.
 *
 * Every number on this screen arrives from `/api/dashboard` and nothing is
 * computed here — not a sum, not a percentage, not a default. That is the §24
 * gate, and an architecture test enforces it by refusing a numeric literal used
 * as a metric value anywhere in this file.
 *
 * Each tile shows the query that produced it. It is small print, and it is the
 * point: a dashboard nobody can trace is a dashboard nobody believes, and the
 * first question about any figure is where it came from.
 *
 * Tiles link to the screen where the work is done. A tile you cannot act on is
 * a decoration.
 */
import Link from 'next/link';
import { Card, EmptyState, ErrorState, LoadingState, fmtMoney } from '@/components/ui';
import { useResource, useSession } from '@/lib/client/use-resource';

type Tone = 'ok' | 'warn' | 'bad' | 'info';

interface Metric {
  key: string;
  label: string;
  value: string;
  hint: string;
  tone?: Tone;
  href?: string;
  query: string;
  money?: boolean;
}

interface MetricGroup {
  key: string;
  label: string;
  metrics: Metric[];
}

/**
 * One tile, in the same shape as the shared `Kpi` component.
 *
 * It is not that component because a dashboard tile does two things that one
 * does not: it links to where the work is, and it names the query behind it.
 */
function Tile({ metric }: { metric: Metric }) {
  const shown = metric.money ? `₹${fmtMoney(metric.value)}` : metric.value;

  const body = (
    <>
      <span className="k">{metric.label}</span>
      <span className={`v${metric.tone ? ` t-${metric.tone}` : ''}`}>{shown}</span>
      <span className="sub">{metric.hint}</span>
      <span className="src" title={`Produced by ${metric.query}()`}>{metric.query}</span>
    </>
  );

  return metric.href ? (
    <Link className="card kpi kpi-link" href={metric.href}>{body}</Link>
  ) : (
    <div className="card kpi">{body}</div>
  );
}

export function Dashboard() {
  const session = useSession();
  const { data, loading, error, reload } = useResource<MetricGroup[]>('/api/dashboard');

  const scope = session.data?.groupWide
    ? 'across the group'
    : session.data?.sites.length === 1
      ? `at ${session.data.sites[0].siteName}`
      : `across ${session.data?.sites.length ?? 0} sites`;

  if (loading) return <LoadingState rows={8} label="Loading the dashboard" />;

  if (error) {
    return (
      <ErrorState
        message={error}
        retry={<button type="button" className="btn" onClick={reload}>Try again</button>}
      />
    );
  }

  if (!data || data.length === 0) {
    return <EmptyState title="Nothing to show yet" />;
  }

  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>
        Every figure below is a live query, scoped to what you can see — {scope}. The small text on each
        tile names the query that produced it.
      </p>

      {data.map(group => (
        <Card key={group.key} title={group.label} label={group.label}>
          <div className="pad kpis">
            {group.metrics.map(metric => (
              <Tile key={metric.key} metric={metric} />
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}
