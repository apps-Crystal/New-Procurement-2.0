'use client';

/**
 * One reconciliation run, item by item.
 *
 * Every row is one of four findings, and they mean different things:
 *
 *   MATCHED         the two sides agree
 *   AMOUNT_DIFFERS  same document, different figure — a real discrepancy
 *   ONLY_IN_PORTAL  this system has it, Tally does not
 *   ONLY_IN_TALLY   Tally has it, this system does not
 *
 * Resolving an item records what was done about it. It does not make the
 * difference go away: `recon_zero_to_close` still refuses to close while the
 * balances differ, so a note is an account of the work rather than a way round
 * it. The screen says that plainly, because a "resolve" button that looked like
 * it cleared the block would be a lie.
 */
import { useState } from 'react';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDate, fmtDateTime, fmtMoney,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface Row { [k: string]: unknown }

interface RunView {
  run: Row & {
    id: number; vendor_id: number; vendor_name: string; vendor_code: string;
    period_start: string; period_end: string;
    portal_balance: string; tally_balance: string; difference: string;
    held_amount: string; status: string;
    vendor_confirmed_balance: string | null;
    reconciled_by_name: string | null; reconciled_at: string | null;
  };
  items: (Row & {
    id: number; match_status: string; note: string | null;
    portal_date: string | null; portal_doc_type: string | null;
    portal_ref: string | null; portal_amount: string | null;
    tally_date: string | null; tally_doc_type: string | null;
    tally_ref: string | null; tally_amount: string | null;
    resolved_by_name: string | null; resolved_at: string | null;
  })[];
}

const COLS = '160px 1fr 1fr 150px';

const FINDING: Record<string, { label: string; chip: string }> = {
  MATCHED: { label: 'Matched', chip: 'chip ok' },
  AMOUNT_DIFFERS: { label: 'Amount differs', chip: 'chip bad' },
  ONLY_IN_PORTAL: { label: 'Only here', chip: 'chip warn' },
  ONLY_IN_TALLY: { label: 'Only in Tally', chip: 'chip warn' },
  MATCHED_TO_DN: { label: 'Matched to a debit note', chip: 'chip ok' },
  OPEN_ITEM: { label: 'Open item', chip: 'chip' },
};

export function ReconDetail({ id, granted }: { id: number; granted: string[] }) {
  const { data, loading, error, reload } = useResource<RunView>(`/api/reconciliation/${id}`);
  const [resolving, setResolving] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [prompt, setPrompt] = useState<'confirm' | 'reopen' | null>(null);
  const [form, setForm] = useState({ balance: '', reason: '' });

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/reconciliation/${id}/transition`, body),
    { onDone: () => { setPrompt(null); reload(); } },
  );

  const resolve = useMutation(
    async (itemId: number) => api.post(`/api/reconciliation/items/${itemId}`, { note }),
    { onDone: () => { setResolving(null); setNote(''); reload(); } },
  );

  if (loading) return <LoadingState rows={8} label="Loading the run" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { run, items } = data;
  const out = Math.abs(Number(run.difference)) >= 0.01;
  const unresolved = items.filter(i => i.match_status !== 'MATCHED' && !i.resolved_at);

  const canResolve = granted.includes('RECON.RESOLVE') && !['RECON_RECONCILED', 'RECON_CONFIRMED_BY_VENDOR'].includes(run.status);
  const canClose = !out && granted.includes('RECON.CLOSE') && ['RECON_OPEN', 'RECON_DIFFERENCE'].includes(run.status);
  const canConfirm = run.status === 'RECON_RECONCILED' && granted.includes('RECON.CONFIRM');
  const canReopen = run.status === 'RECON_RECONCILED' && granted.includes('RECON.REOPEN');

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              {run.vendor_name} <StatusChip status={run.status} />
            </h2>
            <span className="sub">
              {fmtDate(run.period_start)} to {fmtDate(run.period_end)} ·{' '}
              <span className="mono">{run.vendor_code}</span>
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile label="Portal balance" value={`₹${fmtMoney(run.portal_balance)}`} hint="What this system believes" />
          <Tile label="Tally balance" value={`₹${fmtMoney(run.tally_balance)}`} hint="What accounts believe" />
          <Tile
            label="Difference"
            value={out ? `₹${fmtMoney(run.difference)}` : 'None'}
            hint={out ? 'Must be zero to close' : 'The two sides agree'}
          />
          <Tile
            label="Withheld"
            value={`₹${fmtMoney(run.held_amount)}`}
            hint="On open invoices — often part of the gap"
          />
        </div>

        {run.vendor_confirmed_balance && (
          <div className="pad sub" style={{ paddingTop: 0 }}>
            The vendor confirmed ₹{fmtMoney(run.vendor_confirmed_balance)}.
          </div>
        )}
      </Card>

      {out && (
        <Banner kind="bad">
          The two sides are ₹{fmtMoney(run.difference)} apart. This run cannot be closed until they agree —
          correct whichever ledger is wrong and take the reconciliation again. There is no override.
        </Banner>
      )}

      <Card
        title="Findings"
        subtitle={`${items.length} rows compared, ${unresolved.length} unresolved`}
        label="Findings"
      >
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <div>Finding</div>
            <div>Portal</div>
            <div>Tally</div>
            <div>Note</div>
          </div>
          {items.map(i => {
            const finding = FINDING[i.match_status] ?? { label: i.match_status, chip: 'chip' };
            return (
              <div key={i.id} className="tr" style={{ gridTemplateColumns: COLS }}>
                <div>
                  <span className={finding.chip}>{finding.label}</span>
                </div>
                <div>
                  {i.portal_ref ? (
                    <>
                      <span className="mono">{i.portal_ref}</span>
                      <div className="sub">
                        {i.portal_doc_type?.toLowerCase()} · {fmtDate(i.portal_date)} · ₹
                        {fmtMoney(i.portal_amount)}
                      </div>
                    </>
                  ) : (
                    <span className="sub">—</span>
                  )}
                </div>
                <div>
                  {i.tally_ref ? (
                    <>
                      <span className="mono">{i.tally_ref}</span>
                      <div className="sub">
                        {i.tally_doc_type?.toLowerCase()} · {fmtDate(i.tally_date)} · ₹
                        {fmtMoney(i.tally_amount)}
                      </div>
                    </>
                  ) : (
                    <span className="sub">—</span>
                  )}
                </div>
                <div>
                  {resolving === i.id ? (
                    <form
                      onSubmit={e => {
                        e.preventDefault();
                        void resolve.run(i.id);
                      }}
                    >
                      <label htmlFor={`rc-note-${i.id}`} className="sr-only">What was done about it</label>
                      <input
                        id={`rc-note-${i.id}`}
                        className="inp"
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        required
                        minLength={4}
                        maxLength={1000}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <button type="submit" className="btn btn-sm btn-primary" disabled={resolve.busy || note.trim().length < 4}>
                          Save
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setResolving(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      {i.note && <div className="sub">{i.note}</div>}
                      {i.resolved_by_name && (
                        <div className="sub">
                          <strong>{i.resolved_by_name}</strong>
                          {i.resolved_at && `, ${fmtDate(i.resolved_at)}`}
                        </div>
                      )}
                      {canResolve && i.match_status !== 'MATCHED' && !i.resolved_at && (
                        <button type="button" className="btn btn-sm" onClick={() => { setResolving(i.id); setNote(''); }}>
                          Note it
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {resolve.error && <div className="pad"><Banner kind="bad">{resolve.error}</Banner></div>}
        <div className="pad sub" style={{ borderTop: '1px solid var(--line-2)' }}>
          A note records what was done about an item. It does not close the gap — the two balances still
          have to agree before the run can be closed.
        </div>
      </Card>

      <Card title="What happens next" label="Actions">
        <div className="pad">
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {canClose && !prompt && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Both sides agree at ₹{fmtMoney(run.portal_balance)}. Closing signs the period off.
              </p>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'close' })}>
                {act.busy ? 'Closing…' : 'Close the run'}
              </button>
            </>
          )}

          {canConfirm && !prompt && (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Record the balance the vendor confirmed. A figure that disagrees with ₹
                {fmtMoney(run.portal_balance)} is a fresh difference, not a confirmation, and will be
                refused.
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" className="btn btn-primary" onClick={() => setPrompt('confirm')}>
                  Record the vendor confirmation
                </button>
                {canReopen && <button type="button" className="btn" onClick={() => setPrompt('reopen')}>Reopen it</button>}
              </div>
            </>
          )}

          {prompt === 'confirm' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'confirm', vendor_confirmed_balance: form.balance });
              }}
            >
              <div className="field">
                <label htmlFor="rc-confirmed">Balance the vendor confirmed (₹)</label>
                <input
                  id="rc-confirmed"
                  className="inp"
                  inputMode="decimal"
                  value={form.balance}
                  onChange={e => setForm(f => ({ ...f, balance: e.target.value }))}
                  required
                  placeholder={String(run.portal_balance)}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || !form.balance}>
                  {act.busy ? 'Recording…' : 'Record it'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Cancel</button>
              </div>
            </form>
          )}

          {prompt === 'reopen' && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void act.run({ action: 'reopen', reason: form.reason });
              }}
            >
              <Banner kind="warn">Reopening undoes a sign-off. It is recorded as an override.</Banner>
              <div className="field">
                <label htmlFor="rc-reopen">Why is this being reopened?</label>
                <textarea
                  id="rc-reopen"
                  className="inp"
                  rows={2}
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  required
                  minLength={4}
                  maxLength={500}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={act.busy || form.reason.trim().length < 4}>
                  {act.busy ? 'Reopening…' : 'Reopen it'}
                </button>
                <button type="button" className="btn" onClick={() => setPrompt(null)}>Keep it closed</button>
              </div>
            </form>
          )}

          {run.status === 'RECON_CONFIRMED_BY_VENDOR' && (
            <Banner kind="ok">
              Confirmed by the vendor at ₹{fmtMoney(run.vendor_confirmed_balance)}
              {run.reconciled_at ? `, closed ${fmtDateTime(run.reconciled_at)}` : ''}.
            </Banner>
          )}
        </div>
      </Card>
    </>
  );
}
