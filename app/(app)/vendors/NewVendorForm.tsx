'use client';

/**
 * Add a vendor.
 *
 * Client-side checks mirror the server's so the user sees a problem before
 * submitting, but the server decides — §31. Anything the server refuses with a
 * `field` is attached to that input rather than dropped into a banner.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, FieldError } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation } from '@/lib/client/use-resource';
import { GST_STATE_CODES } from '@/lib/validate';

interface Draft {
  legal_name: string;
  pan: string;
  gstin: string;
  state_code: string;
  address: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  msme_number: string;
}

const EMPTY: Draft = {
  legal_name: '',
  pan: '',
  gstin: '',
  state_code: '19',
  address: '',
  contact_name: '',
  contact_email: '',
  contact_phone: '',
  msme_number: '',
};

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function NewVendorForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const router = useRouter();

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => ({ ...d, [key]: value }));

  const mutation = useMutation<Draft>(
    async values => {
      const created = await api.post<{ id: number }>('/api/vendors', values);
      router.prefetch(`/vendors/${created.id}`);
    },
    { successMessage: 'Vendor created as a draft.', onDone: onCreated },
  );

  // Normalised the same way the server will, so the preview matches what is stored.
  const pan = draft.pan.toUpperCase().replace(/[\s-]/g, '');
  const gstin = draft.gstin.toUpperCase().replace(/[\s-]/g, '');

  const panLooksWrong = pan.length > 0 && !PAN_RE.test(pan);
  const gstinPanMismatch = gstin.length === 15 && PAN_RE.test(pan) && gstin.slice(2, 12) !== pan;
  const gstinStateMismatch = gstin.length >= 2 && gstin.slice(0, 2) !== draft.state_code;

  const ready = draft.legal_name.trim() && PAN_RE.test(pan) && draft.address.trim() && !gstinPanMismatch;

  const fieldMessage = (field: string) =>
    mutation.fieldError?.field === field ? mutation.fieldError.message : null;

  return (
    <Card title="New vendor" subtitle="Saved as a draft; a second person approves it before it can be ordered from" pad label="New vendor">
      <div className="grid g3" style={{ marginTop: 12 }}>
        <div className="field" style={{ gridColumn: '1/-1' }}>
          <label htmlFor="nv-name">Legal name</label>
          <input
            id="nv-name"
            className="inp"
            value={draft.legal_name}
            onChange={e => set('legal_name', e.target.value)}
            aria-invalid={!!fieldMessage('legal_name')}
            aria-describedby={fieldMessage('legal_name') ? 'nv-name-err' : undefined}
            placeholder="Northern Polymers & Packaging Pvt Ltd"
          />
          {fieldMessage('legal_name') && <FieldError id="nv-name-err">{fieldMessage('legal_name')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="nv-pan">PAN</label>
          <input
            id="nv-pan"
            className="inp mono"
            value={draft.pan}
            onChange={e => set('pan', e.target.value)}
            aria-invalid={panLooksWrong || !!fieldMessage('pan')}
            aria-describedby="nv-pan-hint"
            placeholder="AABCU9603R"
            maxLength={12}
          />
          <span id="nv-pan-hint" className={`sub ${panLooksWrong ? 't-bad' : ''}`}>
            {fieldMessage('pan') ??
              (panLooksWrong ? 'Five letters, four digits, then one letter.' : 'Ten characters, e.g. AABCU9603R')}
          </span>
        </div>

        <div className="field">
          <label htmlFor="nv-state">State</label>
          <select id="nv-state" className="inp" value={draft.state_code} onChange={e => set('state_code', e.target.value)}>
            {Object.entries(GST_STATE_CODES).map(([code, name]) => (
              <option key={code} value={code}>
                {code} · {name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="nv-gstin">GSTIN (optional)</label>
          <input
            id="nv-gstin"
            className="inp mono"
            value={draft.gstin}
            onChange={e => set('gstin', e.target.value)}
            aria-invalid={gstinPanMismatch || gstinStateMismatch || !!fieldMessage('gstin')}
            aria-describedby="nv-gstin-hint"
            placeholder="19AABCU9603R1ZX"
            maxLength={18}
          />
          <span id="nv-gstin-hint" className={`sub ${gstinPanMismatch || gstinStateMismatch ? 't-bad' : ''}`}>
            {fieldMessage('gstin') ??
              (gstinPanMismatch
                ? `Characters 3–12 are the PAN. This one contains ${gstin.slice(2, 12)}.`
                : gstinStateMismatch
                  ? `This GSTIN is registered in state ${gstin.slice(0, 2)}, not ${draft.state_code}.`
                  : 'Leave blank for an unregistered vendor.')}
          </span>
        </div>

        <div className="field" style={{ gridColumn: '1/-1' }}>
          <label htmlFor="nv-address">Address</label>
          <textarea
            id="nv-address"
            className="inp"
            style={{ minHeight: 64 }}
            value={draft.address}
            onChange={e => set('address', e.target.value)}
            aria-invalid={!!fieldMessage('address')}
          />
        </div>

        <div className="field">
          <label htmlFor="nv-contact">Contact name</label>
          <input id="nv-contact" className="inp" value={draft.contact_name} onChange={e => set('contact_name', e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="nv-email">Contact email</label>
          <input
            id="nv-email"
            className="inp"
            type="email"
            value={draft.contact_email}
            onChange={e => set('contact_email', e.target.value)}
            aria-invalid={!!fieldMessage('contact_email')}
          />
          {fieldMessage('contact_email') && <FieldError id="nv-email-err">{fieldMessage('contact_email')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="nv-phone">Contact phone</label>
          <input
            id="nv-phone"
            className="inp"
            value={draft.contact_phone}
            onChange={e => set('contact_phone', e.target.value)}
            aria-invalid={!!fieldMessage('contact_phone')}
            placeholder="9830012345"
          />
          {fieldMessage('contact_phone') && <FieldError id="nv-phone-err">{fieldMessage('contact_phone')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="nv-msme">MSME number (optional)</label>
          <input id="nv-msme" className="inp" value={draft.msme_number} onChange={e => set('msme_number', e.target.value)} />
        </div>
      </div>

      {mutation.error && (
        <div className="banner bad" style={{ marginTop: 12 }} role="alert">
          {mutation.error}
        </div>
      )}
      {mutation.success && (
        <div className="banner ok" style={{ marginTop: 12 }} role="status">
          {mutation.success}
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
          onClick={() => mutation.run({ ...draft, pan, gstin })}
        >
          {mutation.busy ? 'Saving…' : 'Create vendor'}
        </button>
      </div>
    </Card>
  );
}
