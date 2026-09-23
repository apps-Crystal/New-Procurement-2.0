'use client';

/**
 * Add an item.
 *
 * An item needs an item class, because that is what carries the cold-chain
 * temperature band and the QC checklist version used at receiving. Serialised
 * items get an asset tag per unit, which is why the flag cannot be changed
 * later once stock has moved.
 */
import { useState } from 'react';
import { Card, EmptyState, FieldError } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface ItemClass {
  id: number;
  code: string;
  name: string;
  is_cold_chain: boolean;
}

export function NewItemForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data: classes, loading } = useResource<ItemClass[]>('/api/master/item-classes');

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [itemClassId, setItemClassId] = useState('');
  const [uom, setUom] = useState('Nos');
  const [hsn, setHsn] = useState('');
  const [gstRate, setGstRate] = useState('18');
  const [serialised, setSerialised] = useState(false);
  const [warrantyMonths, setWarrantyMonths] = useState('');

  const mutation = useMutation<Record<string, unknown>>(body => api.post('/api/master/items', body), {
    successMessage: 'Item created.',
    onDone: onCreated,
  });

  const ready = code.trim().length >= 2 && name.trim() && itemClassId && uom.trim();
  const fieldMessage = (field: string) => (mutation.fieldError?.field === field ? mutation.fieldError.message : null);

  if (!loading && (classes?.length ?? 0) === 0) {
    return (
      <EmptyState
        title="An item class is needed first"
        action={
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        }
      >
        Item classes carry the cold-chain temperature band and the QC checklist, so every item must belong to one. Add
        an item class before adding items.
      </EmptyState>
    );
  }

  return (
    <Card title="New item" pad label="New item">
      <div className="grid g3" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="ni-code">Item code</label>
          <input
            id="ni-code"
            className="inp mono"
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="CC-EVP-220"
            aria-invalid={!!fieldMessage('code')}
          />
          {fieldMessage('code') && <FieldError id="ni-code-err">{fieldMessage('code')}</FieldError>}
        </div>

        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label htmlFor="ni-name">Description</label>
          <input id="ni-name" className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="Evaporator coil 22 kW" />
        </div>

        <div className="field">
          <label htmlFor="ni-class">Item class</label>
          <select id="ni-class" className="inp" value={itemClassId} onChange={e => setItemClassId(e.target.value)}>
            <option value="">Select…</option>
            {(classes ?? []).map(c => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
                {c.is_cold_chain ? ' (cold chain)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ni-uom">Unit of measure</label>
          <input id="ni-uom" className="inp" value={uom} onChange={e => setUom(e.target.value)} placeholder="Nos" maxLength={12} />
        </div>

        <div className="field">
          <label htmlFor="ni-gst">Default GST %</label>
          <input id="ni-gst" className="inp mono" value={gstRate} onChange={e => setGstRate(e.target.value)} inputMode="decimal" />
          <span className="sub">Per-line rate on a PR or quotation can differ.</span>
        </div>

        <div className="field">
          <label htmlFor="ni-hsn">HSN / SAC</label>
          <input id="ni-hsn" className="inp mono" value={hsn} onChange={e => setHsn(e.target.value)} maxLength={12} />
        </div>

        <div className="field">
          <label htmlFor="ni-warranty">Warranty (months)</label>
          <input
            id="ni-warranty"
            className="inp mono"
            value={warrantyMonths}
            onChange={e => setWarrantyMonths(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gridColumn: '1/-1' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={serialised}
              onChange={e => setSerialised(e.target.checked)}
              style={{ width: 18, height: 18, marginTop: 2 }}
            />
            <span className="note">
              Serialised — each unit gets its own asset tag.
              <br />
              <span className="sub">This cannot be changed once the item has stock movements.</span>
            </span>
          </label>
        </div>
      </div>

      {mutation.error && (
        <div className="banner bad" style={{ marginTop: 12 }} role="alert">
          {mutation.error}
        </div>
      )}

      <div className="seg" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" className="btn" onClick={onClose} disabled={mutation.busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || mutation.busy}
          onClick={() =>
            mutation.run({
              code,
              name,
              item_class_id: Number(itemClassId),
              uom,
              hsn_sac: hsn || null,
              default_gst_rate: gstRate,
              is_serialised: serialised,
              warranty_months: warrantyMonths ? Number(warrantyMonths) : null,
            })
          }
        >
          {mutation.busy ? 'Saving…' : 'Create item'}
        </button>
      </div>
    </Card>
  );
}
