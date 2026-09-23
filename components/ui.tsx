/**
 * Shared UI primitives.
 *
 * These are the prototype's components, typed. Class names are deliberately the
 * prototype's own (`card`, `chip`, `tr`, `kpi`…) so the CSS in app/globals.css —
 * which is the prototype's CSS — styles them with no translation layer.
 *
 * The six per-screen states the brief requires (§25) are here as real
 * components: the prototype had none, because it rendered synchronously from a
 * JavaScript object.
 */
import type { ReactNode } from 'react';

// --- Status ---------------------------------------------------------------------

export type ChipKind = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

/**
 * Status colours, fixed once for all ~40 screens (docs/01-architecture-map.md §6).
 * Any status not listed falls back to neutral, which is correct for closed and
 * archived states and visible enough to notice if something is missing.
 */
const STATUS_KIND: Record<string, ChipKind> = {
  // Material request
  MR_DRAFT: 'neutral', MR_STOCK_CHECK: 'info', MR_STOCK_AVAILABLE: 'ok',
  MR_STOCK_PARTIAL: 'warn', MR_STOCK_UNAVAILABLE: 'bad',
  MR_TRANSFER_REQUESTED: 'info', MR_TRANSFER_APPROVED: 'ok', MR_TRANSFER_REJECTED: 'bad',
  MR_DECLARED: 'info', MR_APPROVED: 'ok', MR_REJECTED: 'bad',
  MR_CONVERTED_TO_PR: 'neutral', MR_FULFILLED_INTERNAL: 'ok', MR_CANCELLED: 'neutral',
  // Transfer
  TRF_REQUESTED: 'info', TRF_APPROVED: 'ok', TRF_REJECTED: 'bad',
  TRF_DISPATCHED: 'info', TRF_RECEIVED: 'ok', TRF_CANCELLED: 'neutral',
  // Purchase request
  PR_DRAFT: 'neutral', PR_SUBMITTED: 'warn', PR_APPROVED: 'ok', PR_REJECTED: 'bad',
  PO_POSTED: 'info', PR_CLOSED: 'neutral', PR_CANCELLED: 'neutral',
  // Quotation
  QUOTE_RECEIVED: 'info', QUOTE_AWARDED: 'ok', QUOTE_LOST: 'neutral',
  QUOTE_EXPIRED: 'bad', QUOTE_WITHDRAWN: 'neutral',
  // Purchase order
  PO_DRAFT: 'neutral', PO_CREATED: 'ok', PO_PARTIALLY_RECEIVED: 'warn',
  PO_RECEIVED: 'ok', PO_SHORT_CLOSED: 'warn', PO_CLOSED: 'neutral', PO_CANCELLED: 'neutral',
  // Gate inward / QC
  INWARD_RECEIVED: 'info', INWARD_REJECTED: 'bad',
  QC_PENDING: 'warn', QC_IN_PROGRESS: 'warn', QC_COMPLETED: 'ok',
  QC_ACCEPTED: 'ok', QC_CONDITIONAL_HOLD: 'warn', QC_ACCEPTED_CONCESSION: 'warn', QC_REJECTED: 'bad',
  // GRN
  GRN_DRAFT: 'warn', GRN_APPROVED: 'ok', GRN_REJECTED: 'bad', GRN_FLAGGED: 'warn', GRN_CLOSED: 'neutral',
  // Shortfall
  PENDING: 'warn', AWAIT_BALANCE: 'info', SHORT_CLOSE: 'neutral',
  // Damage
  DMG_REPORTED: 'warn', DMG_INSPECTED: 'info', DMG_DECISION_PENDING_APPROVAL: 'warn',
  DMG_UNDER_REPAIR: 'info', DMG_RETURN_RAISED: 'info', DMG_WRITTEN_OFF: 'bad', DMG_CLOSED: 'neutral',
  // RTV
  RTV_DRAFT: 'neutral', RTV_APPROVED: 'ok', RTV_DISPATCHED: 'info',
  RTV_ACKNOWLEDGED: 'info', RTV_CLOSED: 'neutral', RTV_CANCELLED: 'neutral',
  // Vendor
  VENDOR_DRAFT: 'neutral', VENDOR_PENDING: 'warn', VENDOR_APPROVED: 'ok',
  VENDOR_BLOCKED: 'bad', VENDOR_INACTIVE: 'neutral',
  // Accounts
  INV_RECEIVED: 'info', INV_MATCHED: 'ok', INV_PARTIALLY_HELD: 'warn',
  INV_RELEASED: 'ok', INV_PAID: 'neutral', INV_DISPUTED: 'bad',
  DEBIT_NOTE_PENDING: 'warn', DEBIT_NOTE_ISSUED: 'info', CREDIT_NOTE_RECEIVED: 'info',
  DN_ADJUSTED: 'info', DN_RECONCILED: 'ok', DN_CANCELLED: 'neutral',
  RECON_OPEN: 'warn', RECON_DIFFERENCE: 'bad', RECON_RECONCILED: 'ok', RECON_CONFIRMED_BY_VENDOR: 'ok',
  MATCHED: 'ok', AMOUNT_DIFFERS: 'bad', ONLY_IN_PORTAL: 'warn', ONLY_IN_TALLY: 'warn',
  MATCHED_TO_DN: 'info', OPEN_ITEM: 'warn',
  // Stock
  AVAILABLE: 'ok', RESERVED: 'info', IN_TRANSIT: 'info',
  DAMAGED_HOLD: 'warn', UNDER_REPAIR: 'info', WRITTEN_OFF: 'bad',
  BELOW_REORDER: 'bad', NEAR_REORDER: 'warn', HEALTHY: 'ok',
  // Record status / approvals
  ACTIVE: 'ok', INACTIVE: 'neutral', APPROVED: 'ok', REJECTED: 'bad',
  PASS: 'ok', FAIL: 'bad', NA: 'neutral',
};

export function statusKind(status: string): ChipKind {
  return STATUS_KIND[status] ?? 'neutral';
}

/** Status badge. Shows the schema's own code — that is what the prototype does. */
export function Chip({ children, kind }: { children: ReactNode; kind: ChipKind }) {
  return <span className={`chip ${kind}`}>{children}</span>;
}

/** Status badge that picks its own colour from the status code. */
export function StatusChip({ status }: { status: string }) {
  return <Chip kind={statusKind(status)}>{status}</Chip>;
}

// --- Layout -----------------------------------------------------------------------

export function PageHead({
  crumb,
  title,
  docNo,
  status,
  actions,
}: {
  crumb: string;
  title: string;
  docNo?: string;
  status?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="head">
      <div>
        <div className="crumb">{crumb}</div>
        <h1>
          {title}
          {docNo ? <span className="docno">{docNo}</span> : null}
          {status ? <StatusChip status={status} /> : null}
        </h1>
      </div>
      {actions ? <div className="seg" style={{ alignItems: 'center' }}>{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  subtitle,
  right,
  pad,
  className,
  style,
  children,
  label,
}: {
  title?: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  pad?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: ReactNode;
  label?: string;
}) {
  return (
    <section className={`card${pad ? ' pad' : ''}${className ? ` ${className}` : ''}`} style={style} aria-label={label ?? title}>
      {title ? (
        <div className="card-h">
          <div>
            <h2>{title}</h2>
            {subtitle ? <span className="sub">{subtitle}</span> : null}
          </div>
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn' | 'bad' | 'info' }) {
  return (
    <div className="card kpi">
      <span className="k">{label}</span>
      <span className={`v${tone ? ` t-${tone}` : ''}`}>{value}</span>
      {hint ? <span className="sub">{hint}</span> : null}
    </div>
  );
}

export function Kpis({ children }: { children: ReactNode }) {
  return <div className="kpis">{children}</div>;
}

export function Banner({ kind, children }: { kind: ChipKind; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tile">
      <span className="sub">{label}</span>
      <span className="b">{value}</span>
      {hint ? <span className="sub">{hint}</span> : null}
    </div>
  );
}

// --- Progress ------------------------------------------------------------------------

export interface Step {
  label: string;
  sub: string;
  state: 'done' | 'now' | 'todo';
}

export function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps card" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.label}>
          <span className={`dot d-${s.state}`}>{s.state === 'done' ? '✓' : i + 1}</span>
          <span>
            <span className="b" style={{ display: 'block', fontSize: 13 }}>{s.label}</span>
            <span className="sub">{s.sub}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Bars({ labels, upto }: { labels: string[]; upto: number }) {
  return (
    <ol className="bars" aria-label="Progress">
      {labels.map((l, i) => (
        <li key={l} className={i <= upto ? 'on' : ''}>
          <span className="bar" />
          {l}
        </li>
      ))}
    </ol>
  );
}

// --- The six screen states (§25) --------------------------------------------------------

export function LoadingState({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="card" aria-busy="true" aria-label={label}>
      <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 18, width: `${100 - i * 7}%` }} />
        ))}
      </div>
      <span className="sr">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card state">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ title = 'That did not load', message, retry }: { title?: string; message: string; retry?: ReactNode }) {
  return (
    <div className="card state" role="alert">
      <h3 className="t-bad">{title}</h3>
      <p>{message}</p>
      {retry}
    </div>
  );
}

/** Inline validation message, tied to an input via aria-describedby. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span className="err-text" id={id} role="alert">
      {children}
    </span>
  );
}

// --- Permission-aware actions --------------------------------------------------------------

/**
 * Renders children only when the permission is held.
 *
 * Presentation only. The route and the service check the same key server-side —
 * this exists so a user is not shown a button that will refuse them.
 */
export function PermissionGate({ granted, needs, children, fallback = null }: { granted: string[]; needs: string; children: ReactNode; fallback?: ReactNode }) {
  return granted.includes(needs) ? <>{children}</> : <>{fallback}</>;
}

// --- Formatting -------------------------------------------------------------------------------

/**
 * Indian digit grouping, matching the prototype's `f()`.
 * Quantities and money both arrive from Postgres as strings to avoid float
 * error; they are formatted, never re-computed.
 */
export function fmtNum(v: number | string | null | undefined, opts: Intl.NumberFormatOptions = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', opts);
}

/** Money: two decimals, Indian grouping, no symbol (screens add ₹ where it belongs). */
export function fmtMoney(v: number | string | null | undefined): string {
  return fmtNum(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Quantity: up to three decimals, trailing zeros dropped. */
export function fmtQty(v: number | string | null | undefined): string {
  return fmtNum(v, { maximumFractionDigits: 3 });
}

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
