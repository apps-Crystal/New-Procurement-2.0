'use client';

/**
 * A debit note, its credit notes, and the variance rule.
 *
 * Conflict C-14 is the whole point of this screen. `compute_cn_variance()`
 * flags a credit note more than 2% short of what was debited and then nothing
 * in the schema acts on the flag. Here it blocks reconciliation, and clearing
 * the block is a Functional Head's decision recorded as an OVERRIDE — accepting
 * less money than was claimed is a thing somebody should be able to find later.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDate, fmtDateTime, fmtMoney,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Row { [k: string]: unknown }

/** `compute_cn_variance()` flags anything above this. */
const VARIANCE_LIMIT = 2;

interface NoteView {
  dn: Row & {
    id: number; dn_no: string; status: string; vendor_name: string;
    po_no: string; po_id: number; site_name: string;
    rtv_no: string | null; rtv_id: number | null; sht_no: string | null;
    invoice_no: string | null; invoice_id: number | null;
    taxable_value: string; cgst: string; sgst: string; igst: string; total: string;
    value_override_remark: string | null; tally_voucher_ref: string | null;
    issued_by_name: string | null; issued_at: string | null; reconciled_at: string | null;
  };
  creditNotes: (Row & {
    id: number; cn_no: string; cn_date: string; value: string;
    variance_pct: string; variance_flagged: boolean;
    accepted_short_by: number | null; accepted_short_by_name: string | null;
    recorded_by_name: string; created_at: string;
  })[];
  offsets: (Row & {
    id: number; invoice_no: string; amount: string; bill_control_ref: string | null;
    offset_by_name: string; offset_at: string;
  })[];
}

export function NoteDetail({ id, granted }: { id: number; granted: string[] }) {
  const { data, loading, error, reload } = useResource<NoteView>(`/api/debit-notes/${id}`);
  const [prompt, setPrompt] = useState<'issue' | 'credit' | 'reconcile' | 'accept' | null>(null);
  const [form, setForm] = useState({ voucher: '', cnNo: '', cnDate: '', value: '', reason: '' });

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/debit-notes/${id}/transition`, body),
    { onDone: () => { setPrompt(null); reload(); } },
  );

  const accept = useMutation(
    async (cnId: number) => api.post(`/api/debit-notes/credit-notes/${cnId}`, { reason: form.reason }),
    { onDone: () => { setPrompt(null); setForm(f => ({ ...f, reason: '' })); reload(); } },
  );

  if (loading) return <LoadingState rows={8} label="Loading the note" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { dn, creditNotes, offsets } = data;
  const latest = creditNotes[0] ?? null;
  const blocked = latest !== null && latest.variance_flagged && latest.accepted_short_by === null;

  const canIssue = dn.status === 'DEBIT_NOTE_PENDING' && granted.includes('DEBIT_NOTE.ISSUE');
  const canRecordCredit = dn.status === 'DEBIT_NOTE_ISSUED' && granted.includes('DEBIT_NOTE.ISSUE');
  const canReconcile =
    ['CREDIT_NOTE_RECEIVED', 'DN_ADJUSTED'].includes(dn.status) && granted.includes('DEBIT_NOTE.RECONCILE');
  // Accepting a short credit writes off the difference, so it is the same
  // authority that may reopen a closed reconciliation.
  const canAccept = blocked && granted.includes('RECON.REOPEN');

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{dn.dn_no}</span> <StatusChip status={dn.status} />
            </h2>
            <span className="sub">
              {dn.vendor_name} · against{' '}
              {dn.rtv_id ? (
                <Link href={`/returns/${dn.rtv_id}`} className="mono">{dn.rtv_no}</Link>
              ) : (
                <span className="mono">{dn.sht_no}</span>
              )}{' '}
              · <Link href={`/po/${dn.po_id}`} className="mono">{dn.po_no}</Link> · {dn.site_name}
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile label="Taxable" value={`₹${fmtMoney(dn.taxable_value)}`} />
          <Tile
            label={Number(dn.igst) > 0 ? 'IGST' : 'CGST + SGST'}
            value={`₹${fmtMoney(Number(dn.igst) > 0 ? dn.igst : Number(dn.cgst) + Number(dn.sgst))}`}
            hint={dn.invoice_id ? `Mirrored from ${dn.invoice_no}` : 'No invoice to mirror'}
          />
          <Tile label="Total debited" value={`₹${fmtMoney(dn.total)}`} />
          <Tile
            label="Tally voucher"
            value={dn.tally_voucher_ref ?? 'Not set'}
            hint={dn.issued_at ? `Issued ${fmtDateTime(dn.issued_at)}` : 'Not issued'}
          />
        </div>

        {dn.value_override_remark && (
          <div className="pad sub" style={{ paddingTop: 0 }}>
            <strong>Value changed by Accounts:</strong> {dn.value_override_remark}
          </div>
        )}
      </Card>

      {blocked && (
        <Banner kind="bad">
          Credit note {latest?.cn_no} is {latest?.variance_pct}% short of what was debited, above the{' '}
          {VARIANCE_LIMIT}% tolerance. This cannot be reconciled until a Functional Head accepts the
          shortfall.
        </Banner>
      )}

      {creditNotes.length > 0 && (
        <Card title="Credit notes" label="Credit notes">
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: '160px 130px 130px 1fr 150px' }}>
              <div>Number</div>
              <div>Date</div>
              <div className="r">Value</div>
              <div>Variance</div>
              <div>Recorded by</div>
            </div>
            {creditNotes.map(c => (
              <div key={c.id} className="tr" style={{ gridTemplateColumns: '160px 130px 130px 1fr 150px' }}>
                <div className="mono">{c.cn_no}</div>
                <div>{fmtDate(c.cn_date)}</div>
                <div className="r">₹{fmtMoney(c.value)}</div>
                <div>
                  {c.variance_flagged ? (
                    <>
                      <span className={c.accepted_short_by ? 'chip warn' : 'chip bad'}>
                        {c.variance_pct}% short
                      </span>
                      {c.accepted_short_by_name && (
                        <div className="sub">accepted by {c.accepted_short_by_name}</div>
                      )}
                    </>
                  ) : (
                    <span className="chip ok">{c.variance_pct}% — within tolerance</span>
                  )}
                </div>
                <div className="sub">{c.recorded_by_name}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {offsets.length > 0 && (
        <Card title="Set against invoices" label="Offsets">
          <div className="tbl">
            {offsets.map(o => (
              <div key={o.id} className="tr" style={{ gridTemplateColumns: '180px 1fr 140px 150px' }}>
                <div className="mono">{o.invoice_no}</div>
                <div className="sub">{o.bill_control_ref ?? '—'}</div>
                <div className="r">₹{fmtMoney(o.amount)}</div>
                <div className="sub">{o.offset_by_name}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}
          {accept.error && <Banner kind="bad">{accept.error}</Banner>}

          {canIssue && !prompt && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Issuing tells the vendor and reduces the payable by ₹{fmtMoney(dn.total)}. Until then this
                is a draft.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setPrompt('issue')}>Issue it</button>
            </>
          )}

          {canRecordCredit && !prompt && (
            <button type="button" className="btn btn-primary" onClick={() => setPrompt('credit')}>
              Record the vendor&rsquo;s credit note
            </button>
          )}

          {canReconcile && !prompt && !blocked && (
            <button type="button" className="btn btn-primary" onClick={() => setPrompt('reconcile')}>
              Reconcile it
            </button>
          )}

          {canAccept && !prompt && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Accepting writes off the ₹{fmtMoney(Number(dn.total) - Number(latest?.value ?? 0))}{' '}
                difference and unblocks reconciliation. It is recorded as an override.
              </p>
              <button type="button" className="btn" onClick={() => setPrompt('accept')}>
                Accept the shortfall
              </button>
            </>
          )}

          {blocked && !canAccept && (
            <Banner kind="info">
              This is waiting for a Functional Head to accept the shortfall, or for the vendor to issue a
              fuller credit note.
            </Banner>
          )}

          {prompt === 'issue' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'issue', tally_voucher_ref: form.voucher || null });
              }}
            >
              <div className="field">
                <label htmlFor="dn-voucher">Tally voucher reference</label>
                <input id="dn-voucher" className="inp" value={form.voucher} onChange={e => setForm(f => ({ ...f, voucher: e.target.value }))} maxLength={80} placeholder="Optional now, required to reconcile" />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy}>
                  {act.busy ? 'Issuing…' : 'Issue the note'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {prompt === 'credit' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({
                  action: 'credit-note', cn_no: form.cnNo, cn_date: form.cnDate, value: form.value,
                });
              }}
            >
              <div className="grid g3">
                <div className="field">
                  <label htmlFor="cn-no">Credit note number</label>
                  <input id="cn-no" className="inp mono" value={form.cnNo} onChange={e => setForm(f => ({ ...f, cnNo: e.target.value }))} required maxLength={80} />
                </div>
                <div className="field">
                  <label htmlFor="cn-date">Date</label>
                  <input id="cn-date" className="inp" type="date" value={form.cnDate} onChange={e => setForm(f => ({ ...f, cnDate: e.target.value }))} required />
                </div>
                <div className="field">
                  <label htmlFor="cn-value">Value (₹)</label>
                  <input id="cn-value" className="inp" inputMode="decimal" value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} required />
                  <span className="sub">₹{fmtMoney(dn.total)} was debited</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || !form.cnNo || !form.cnDate || !form.value}>
                  {act.busy ? 'Recording…' : 'Record it'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
              <p className="sub" style={{ marginBottom: 0 }}>
                Anything more than {VARIANCE_LIMIT}% short of what was debited is flagged automatically and
                will block reconciliation.
              </p>
            </form>
          )}

          {prompt === 'reconcile' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'reconcile', tally_voucher_ref: form.voucher || dn.tally_voucher_ref });
              }}
            >
              <div className="field">
                <label htmlFor="dn-rec-voucher">Tally voucher reference</label>
                <input
                  id="dn-rec-voucher"
                  className="inp"
                  value={form.voucher || (dn.tally_voucher_ref ?? '')}
                  onChange={e => setForm(f => ({ ...f, voucher: e.target.value }))}
                  required
                  maxLength={80}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy}>
                  {act.busy ? 'Reconciling…' : 'Reconcile'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {prompt === 'accept' && latest && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void accept.run(latest.id);
              }}
            >
              <Banner kind="warn">
                This writes off ₹{fmtMoney(Number(dn.total) - Number(latest.value))} that the vendor did not
                credit back. It is recorded against your name as an override.
              </Banner>
              <div className="field">
                <label htmlFor="cn-accept">Why is the shortfall being accepted?</label>
                <textarea
                  id="cn-accept"
                  className="inp"
                  rows={2}
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  required
                  minLength={10}
                  maxLength={1000}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={accept.busy || form.reason.trim().length < 10}>
                  {accept.busy ? 'Accepting…' : 'Accept the shortfall'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {dn.status === 'DN_RECONCILED' && (
            <Banner kind="ok">
              Reconciled{dn.reconciled_at ? ` on ${fmtDateTime(dn.reconciled_at)}` : ''} against voucher{' '}
              <span className="mono">{dn.tally_voucher_ref}</span>.
            </Banner>
          )}
        </div>
      </Card>
    </>
  );
}
