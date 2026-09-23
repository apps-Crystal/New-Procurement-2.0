'use client';

/**
 * Issue stock.
 *
 * The item list is what is actually available at the chosen site, with the
 * quantity shown against each — so an issue that cannot be met is visible
 * before it is submitted rather than refused after. The server still checks
 * under a lock: what is on screen is a moment old, and two people issuing the
 * last pallet must not both succeed.
 */
import { useEffect, useMemo, useState } from 'react';
import { Banner, Card, FieldError, fmtQty } from '@/components/ui';
import { api, qs } from '@/lib/client/api';
import { useMutation, useResource, useSession } from '@/lib/client/use-resource';

interface Position {
  item_id: number;
  code: string;
  name: string;
  uom: string;
  available: string;
}

interface Line {
  itemId: string;
  qty: string;
}

const BLANK: Line = { itemId: '', qty: '' };

export function NewIssueForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const session = useSession();
  const sites = useMemo(() => session.data?.sites ?? [], [session.data]);

  const [siteId, setSiteId] = useState('');
  const [issuedTo, setIssuedTo] = useState('');
  const [lines, setLines] = useState<Line[]>([{ ...BLANK }]);

  useEffect(() => {
    if (!siteId && sites.length > 0) setSiteId(String(sites[0].siteId));
  }, [sites, siteId]);

  const stock = useResource<Position[]>(siteId ? `/api/inventory${qs({ site_id: siteId })}` : null, [siteId]);

  const create = useMutation(
    async () =>
      api.post('/api/issues', {
        site_id: Number(siteId),
        issued_to: issuedTo,
        lines: lines
          .filter(l => l.itemId && l.qty)
          .map(l => ({ item_id: Number(l.itemId), qty: l.qty })),
      }),
    { onDone: onCreated, successMessage: 'Stock issued.' },
  );

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(prev => prev.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const err = (field: string) => (create.fieldError?.field === field ? create.fieldError.message : null);

  const available = (itemId: string) => stock.data?.find(p => String(p.item_id) === itemId);

  const chosen = lines.map(l => l.itemId).filter(Boolean);
  const duplicated = chosen.length !== new Set(chosen).size;
  const overdrawn = lines.some(l => {
    const pos = available(l.itemId);
    return pos !== undefined && l.qty !== '' && Number(l.qty) > Number(pos.available);
  });
  const ready = lines.some(l => l.itemId && l.qty) && issuedTo.trim().length >= 2;

  return (
    <Card
      title="Issue stock"
      label="Issue stock"
      right={<button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>}
    >
      <form
        className="pad"
        onSubmit={e => {
          e.preventDefault();
          void create.run(undefined);
        }}
      >
        {create.error && <Banner kind="bad">{create.error}</Banner>}
        {duplicated && (
          <Banner kind="warn">The same item appears on more than one line. Combine them into one.</Banner>
        )}
        {overdrawn && (
          <Banner kind="warn">
            One of these lines asks for more than is available. Nothing will be issued at all if it is —
            the whole issue posts together or not at all.
          </Banner>
        )}

        <div className="grid g2">
          <div className="field">
            <label htmlFor="ni-site">From which site?</label>
            <select id="ni-site" className="inp" value={siteId} onChange={e => setSiteId(e.target.value)} required>
              {sites.map(s => (
                <option key={s.siteId} value={s.siteId}>{s.siteName}</option>
              ))}
            </select>
            {err('site_id') && <FieldError id="ni-site">{err('site_id')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="ni-to">Issued to</label>
            <input
              id="ni-to"
              className="inp"
              value={issuedTo}
              onChange={e => setIssuedTo(e.target.value)}
              required
              minLength={2}
              maxLength={200}
              placeholder="Freezer block maintenance, WO-4471"
            />
            {err('issued_to') && <FieldError id="ni-to">{err('issued_to')}</FieldError>}
          </div>
        </div>

        <h4 style={{ margin: '18px 0 8px' }}>What is going out</h4>

        {lines.map((line, i) => {
          const pos = available(line.itemId);
          const over = pos !== undefined && line.qty !== '' && Number(line.qty) > Number(pos.available);

          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 150px 150px 40px', gap: 10, marginBottom: 8 }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`ni-item-${i}`} className="sr-only">Item</label>
                <select
                  id={`ni-item-${i}`}
                  className="inp"
                  value={line.itemId}
                  onChange={e => setLine(i, { itemId: e.target.value })}
                  required
                >
                  <option value="">Choose an item…</option>
                  {(stock.data ?? [])
                    .filter(p => Number(p.available) > 0)
                    .map(p => (
                      <option key={p.item_id} value={p.item_id}>
                        {p.code} — {p.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`ni-qty-${i}`} className="sr-only">Quantity</label>
                <input
                  id={`ni-qty-${i}`}
                  className="inp"
                  inputMode="decimal"
                  value={line.qty}
                  onChange={e => setLine(i, { qty: e.target.value })}
                  placeholder="Quantity"
                  aria-invalid={over || undefined}
                  required
                />
              </div>
              <div className="sub" style={{ alignSelf: 'center' }}>
                {pos ? (
                  <>
                    {fmtQty(pos.available)} {pos.uom} available
                    {over && <div><strong>not enough</strong></div>}
                  </>
                ) : (
                  ''
                )}
              </div>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={`Remove line ${i + 1}`}
                disabled={lines.length === 1}
                onClick={() => setLines(prev => prev.filter((_, n) => n !== i))}
              >
                ×
              </button>
            </div>
          );
        })}

        <button type="button" className="btn btn-sm" onClick={() => setLines(prev => [...prev, { ...BLANK }])}>
          Add another line
        </button>

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button type="submit" className="btn btn-primary" disabled={create.busy || !ready || duplicated}>
            {create.busy ? 'Issuing…' : 'Issue the stock'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>

        <p className="sub" style={{ marginBottom: 0 }}>
          This posts straight to the ledger. To correct an issue afterwards, reverse its movement — issues
          are not editable.
        </p>
      </form>
    </Card>
  );
}
