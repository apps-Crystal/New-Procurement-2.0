'use client';

/**
 * Raise a material request.
 *
 * Lines are item plus quantity and nothing else — no rate. A material request
 * says what is needed, not what it costs; pricing arrives with the PR, and
 * asking for it here would invite a number nobody has yet.
 */
import { useState } from 'react';
import { Banner, Card, FieldError } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource, useSession } from '@/lib/client/use-resource';
import { ENUMS } from '@/lib/enums';

interface Item {
  id: number;
  code: string;
  name: string;
  uom: string;
}

interface Line {
  itemId: string;
  qty: string;
}

const BLANK: Line = { itemId: '', qty: '' };

export function NewMrForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const session = useSession();
  const items = useResource<Item[]>('/api/master/items');

  const [siteId, setSiteId] = useState('');
  const [category, setCategory] = useState('');
  const [urgency, setUrgency] = useState('ROUTINE');
  const [requiredBy, setRequiredBy] = useState('');
  const [lines, setLines] = useState<Line[]>([{ ...BLANK }]);

  const create = useMutation(
    async () =>
      api.post('/api/mr', {
        site_id: Number(siteId),
        category,
        urgency,
        required_by: requiredBy,
        lines: lines
          .filter(l => l.itemId && l.qty)
          .map(l => ({ item_id: Number(l.itemId), qty_requested: l.qty })),
      }),
    { onDone: onCreated, successMessage: 'Request raised.' },
  );

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(prev => prev.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const sites = session.data?.sites ?? [];
  const err = (field: string) => (create.fieldError?.field === field ? create.fieldError.message : null);

  // The duplicate check is here only to save a round trip; `mr_lines_item_uq`
  // is what actually decides, and its refusal is the one the user would see.
  const chosen = lines.map(l => l.itemId).filter(Boolean);
  const duplicated = chosen.length !== new Set(chosen).size;

  return (
    <Card
      title="New material request"
      label="New material request"
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
        {duplicated && <Banner kind="warn">The same item appears on more than one line. Combine them into a single line.</Banner>}

        <div className="grid g4">
          <div className="field">
            <label htmlFor="mr-site">Site</label>
            <select id="mr-site" className="inp" value={siteId} onChange={e => setSiteId(e.target.value)} required>
              <option value="">Choose a site…</option>
              {sites.map(s => (
                <option key={s.siteId} value={s.siteId}>{s.siteName}</option>
              ))}
            </select>
            {err('site_id') && <FieldError id="mr-site">{err('site_id')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="mr-category">Category</label>
            <select id="mr-category" className="inp" value={category} onChange={e => setCategory(e.target.value)} required>
              <option value="">Choose…</option>
              {ENUMS.category_code.map(c => (
                <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </select>
            {err('category') && <FieldError id="mr-category">{err('category')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="mr-urgency">Urgency</label>
            <select id="mr-urgency" className="inp" value={urgency} onChange={e => setUrgency(e.target.value)}>
              {ENUMS.urgency_code.map(u => (
                <option key={u} value={u}>{u.toLowerCase()}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="mr-by">Needed by</label>
            <input id="mr-by" className="inp" type="date" value={requiredBy} onChange={e => setRequiredBy(e.target.value)} required />
            {err('required_by') && <FieldError id="mr-by">{err('required_by')}</FieldError>}
          </div>
        </div>

        <h4 style={{ margin: '18px 0 8px' }}>What is needed</h4>

        {lines.map((line, i) => {
          const item = items.data?.find(x => String(x.id) === line.itemId);
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 160px 70px 40px', gap: 10, marginBottom: 8 }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`mr-item-${i}`} className="sr-only">Item</label>
                <select
                  id={`mr-item-${i}`}
                  className="inp"
                  value={line.itemId}
                  onChange={e => setLine(i, { itemId: e.target.value })}
                  required
                >
                  <option value="">Choose an item…</option>
                  {(items.data ?? []).map(it => (
                    <option key={it.id} value={it.id}>{it.code} — {it.name}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`mr-qty-${i}`} className="sr-only">Quantity</label>
                <input
                  id={`mr-qty-${i}`}
                  className="inp"
                  value={line.qty}
                  onChange={e => setLine(i, { qty: e.target.value })}
                  placeholder="Quantity"
                  inputMode="decimal"
                  required
                />
              </div>
              <div className="sub" style={{ alignSelf: 'center' }}>{item?.uom ?? ''}</div>
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
          <button type="submit" className="btn btn-primary" disabled={create.busy || duplicated}>
            {create.busy ? 'Raising…' : 'Raise request'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
