'use client';

/**
 * Debit notes, and the credit notes that answer them.
 *
 * The variance column is the one that matters. `compute_cn_variance()` flags a
 * credit note more than 2% short of what was debited, and a flagged note blocks
 * reconciliation until a Functional Head accepts the shortfall — that is
 * conflict C-14, which the schema flags and then does nothing about.
 *
 * So the register shows the gap, not just the status: "credit note received" on
 * its own tells nobody whether the vendor actually paid what they owed.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, EmptyState, ErrorState, Kpi, Kpis, LoadingState, StatusChip, fmtDate, fmtMoney,
} from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';
import { NewDebitNoteForm } from '@/app/(app)/notes/NewDebitNoteForm';

interface Note {
  id: number;
  dn_no: string;
  status: string;
  vendor_name: string;
  po_no: string;
  site_name: string;
  rtv_no: string | null;
  sht_no: string | null;
  invoice_no: string | null;
  taxable_value: string;
  total: string;
  cn_no: string | null;
  cn_value: string | null;
  variance_pct: string | null;
  variance_flagged: boolean | null;
  accepted_short: boolean | null;
  tally_voucher_ref: string | null;
  created_at: string;
}

const COLS = '160px 1fr 140px 130px 180px 150px';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'DEBIT_NOTE_PENDING' },
  { label: 'Issued', value: 'DEBIT_NOTE_ISSUED' },
  { label: 'Credit received', value: 'CREDIT_NOTE_RECEIVED' },
  { label: 'Reconciled', value: 'DN_RECONCILED' },
];

export function NoteRegister({ granted }: { granted: string[] }) {
  const [status, setStatus] = useState('');
  const [raising, setRaising] = useState(false);

  const url = `/api/debit-notes${qs({ status })}`;
  const { data, loading, error, reload } = useResource<Note[]>(url, [status]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      toIssue: rows.filter(n => n.status === 'DEBIT_NOTE_PENDING').length,
      blocked: rows.filter(n => n.variance_flagged && !n.accepted_short && n.status !== 'DN_RECONCILED').length,
      value: rows.filter(n => n.status !== 'DN_CANCELLED').reduce((s, n) => s + Number(n.total ?? 0), 0),
    };
  }, [data]);

  const canRaise = granted.includes('DEBIT_NOTE.ISSUE');

  return (
    <>
      <Kpis>
        <Kpi label="Debit notes" value={counts.total} hint="Matching the current filter" />
        <Kpi label="Not yet issued" value={counts.toIssue} hint="The vendor has not been told" tone={counts.toIssue ? 'warn' : undefined} />
        <Kpi label="Blocked on variance" value={counts.blocked} hint="Credit note short by more than 2%" tone={counts.blocked ? 'bad' : 'ok'} />
        <Kpi label="Debited" value={`₹${fmtMoney(counts.value)}`} hint="Including tax" />
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

        {canRaise && !raising && (
          <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setRaising(true)}>
            Raise a debit note
          </button>
        )}
      </section>

      {raising && (
        <NewDebitNoteForm
          onClose={() => setRaising(false)}
          onCreated={() => {
            setRaising(false);
            reload();
          }}
        />
      )}

      {loading && <LoadingState rows={6} label="Loading notes" />}

      {!loading && error && (
        <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />
      )}

      {!loading && !error && data?.length === 0 && (
        <EmptyState
          title={status ? 'Nothing matches that' : 'No debit notes'}
          action={
            status ? (
              <button type="button" className="btn" onClick={() => setStatus('')}>Clear filter</button>
            ) : canRaise ? (
              <button type="button" className="btn btn-primary" onClick={() => setRaising(true)}>Raise a debit note</button>
            ) : null
          }
        >
          A debit note is the money side of something physical: goods that went back, or goods that never
          came. It is raised against a dispatched return or a short-closed shortfall.
        </EmptyState>
      )}

      {!loading && !error && (data?.length ?? 0) > 0 && (
        <Card label="Debit notes">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <div>Number</div>
              <div>Vendor and origin</div>
              <div className="r">Debited</div>
              <div className="r">Credited</div>
              <div>Variance</div>
              <div>Stage</div>
            </div>
            {(data ?? []).map(n => (
              <Link key={n.id} href={`/notes/${n.id}`} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div className="mono">
                  {n.dn_no}
                  <div className="sub">{fmtDate(n.created_at)}</div>
                </div>
                <div>
                  {n.vendor_name}
                  <div className="sub">
                    <span className="mono">{n.rtv_no ?? n.sht_no}</span> · {n.po_no}
                    {n.invoice_no && ` · ${n.invoice_no}`}
                  </div>
                </div>
                <div className="r">₹{fmtMoney(n.total)}</div>
                <div className="r">
                  {n.cn_value === null ? <span className="sub">—</span> : `₹${fmtMoney(n.cn_value)}`}
                  {n.cn_no && <div className="sub mono">{n.cn_no}</div>}
                </div>
                <div>
                  {n.variance_pct === null ? (
                    <span className="sub">no credit note yet</span>
                  ) : n.variance_flagged ? (
                    <>
                      <span className={n.accepted_short ? 'chip warn' : 'chip bad'}>{n.variance_pct}% short</span>
                      <div className="sub">{n.accepted_short ? 'accepted' : 'blocks reconciling'}</div>
                    </>
                  ) : (
                    <span className="chip ok">within 2%</span>
                  )}
                </div>
                <div><StatusChip status={n.status} /></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
