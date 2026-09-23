'use client';

/**
 * Raise a return.
 *
 * The form picks an origin, not a quantity. What goes back comes from the
 * record behind it — the QC verdict, the damage report or the shortfall case —
 * so a return can never claim more than the thing that actually went wrong.
 *
 * The only real choice is the basis, and it matters: a CREDIT return expects a
 * credit note, a REPLACEMENT expects goods back, and FREE_REPLACEMENT expects
 * them at no charge because the vendor is at fault.
 */
import { useMemo, useState } from 'react';
import { Banner, Card, FieldError, fmtQty } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { ENUMS } from '@/lib/enums';
import { SOURCE_LABEL } from '@/app/(app)/returns/ReturnRegister';

interface Origin {
  source: string;
  source_id: number;
  reference: string;
  site_name: string;
  vendor_name: string;
  po_no: string;
  qty: string;
}

const BASIS_HINT: Record<string, string> = {
  CREDIT: 'The vendor issues a credit note; nothing comes back.',
  REPLACEMENT: 'The vendor sends replacement goods, charged as agreed.',
  FREE_REPLACEMENT: 'The vendor replaces it at no charge — their fault.',
  REPAIR_AND_RETURN: 'The vendor repairs it and sends the same unit back.',
};

/**
 * Whether approving this return will move stock.
 *
 * Only warehouse damage ever entered inventory. Saying so up front stops the
 * two that post nothing looking like a mistake later.
 */
function movesStock(source: string): boolean {
  return source === 'WAREHOUSE_DAMAGE';
}

export function NewReturnForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const origins = useResource<Origin[]>('/api/rtv/origins');

  const [key, setKey] = useState('');
  const [basis, setBasis] = useState('CREDIT');

  const chosen = useMemo(
    () => (origins.data ?? []).find(o => `${o.source}:${o.source_id}` === key) ?? null,
    [origins.data, key],
  );

  const create = useMutation(
    async () => {
      if (!chosen) return;
      return api.post('/api/rtv', {
        source: chosen.source,
        basis,
        qc_id: chosen.source === 'QC_REJECTION' ? chosen.source_id : null,
        damage_id: chosen.source === 'WAREHOUSE_DAMAGE' ? chosen.source_id : null,
        shortfall_id: chosen.source === 'SHORTFALL' ? chosen.source_id : null,
      });
    },
    { onDone: onCreated, successMessage: 'Return raised.' },
  );

  const err = (field: string) => (create.fieldError?.field === field ? create.fieldError.message : null);

  return (
    <Card
      title="Raise a purchase return"
      label="Raise a return"
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

        <div className="grid g2">
          <div className="field">
            <label htmlFor="rtv-origin">What is going back?</label>
            <select id="rtv-origin" className="inp" value={key} onChange={e => setKey(e.target.value)} required>
              <option value="">Choose an origin…</option>
              {(origins.data ?? []).map(o => (
                <option key={`${o.source}:${o.source_id}`} value={`${o.source}:${o.source_id}`}>
                  {o.reference} — {SOURCE_LABEL[o.source] ?? o.source} — {o.vendor_name}
                </option>
              ))}
            </select>
            {origins.data?.length === 0 && (
              <span className="sub">
                Nothing is waiting to be returned. Origins appear here from rejected inspections, damage
                cleared for return, and shortfalls the vendor still owes.
              </span>
            )}
            {err('source') && <FieldError id="rtv-origin">{err('source')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="rtv-basis">On what basis?</label>
            <select id="rtv-basis" className="inp" value={basis} onChange={e => setBasis(e.target.value)}>
              {ENUMS.rtv_basis.map(b => (
                <option key={b} value={b}>{b.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </select>
            <span className="sub">{BASIS_HINT[basis]}</span>
          </div>
        </div>

        {chosen && (
          <>
            <div className="grid g4" style={{ marginTop: 6 }}>
              <div className="field">
                <span className="lbl">Vendor</span>
                <div style={{ paddingTop: 6 }}>{chosen.vendor_name}</div>
              </div>
              <div className="field">
                <span className="lbl">Against order</span>
                <div className="mono" style={{ paddingTop: 6 }}>{chosen.po_no}</div>
              </div>
              <div className="field">
                <span className="lbl">Quantity</span>
                <div style={{ paddingTop: 6 }}>{fmtQty(chosen.qty)}</div>
              </div>
              <div className="field">
                <span className="lbl">Site</span>
                <div style={{ paddingTop: 6 }}>{chosen.site_name}</div>
              </div>
            </div>

            <Banner kind={movesStock(chosen.source) ? 'warn' : 'info'}>
              {movesStock(chosen.source)
                ? 'This stock is quarantined here. Approving the return takes it out of damaged hold — that is the moment it leaves the books.'
                : 'This material never entered stock, so approving the return posts no movement. The return is the paperwork that lets a credit or a replacement be chased.'}
            </Banner>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button type="submit" className="btn btn-primary" disabled={create.busy || !chosen}>
            {create.busy ? 'Raising…' : 'Raise the return'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>

        <p className="sub" style={{ marginBottom: 0 }}>
          The PRN and the gate pass are minted when somebody else approves it. Nothing can leave the
          premises until they exist.
        </p>
      </form>
    </Card>
  );
}
