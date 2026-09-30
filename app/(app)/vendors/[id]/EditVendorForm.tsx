'use client';

/**
 * Edit a vendor.
 *
 * `updateVendor()` and PATCH /api/vendors/[id] have always existed; nothing
 * called them, so a vendor could be created and never corrected — a missing
 * contact number meant blocking the record and starting again.
 *
 * On an APPROVED vendor the identity fields freeze: PAN, GSTIN and state are
 * referenced by live purchase orders, so changing them would quietly re-point
 * orders at a different legal entity. The service refuses it —
 *
 *   "PAN, GSTIN and state cannot be changed on an approved vendor. Block this
 *    vendor and create a new record if their registration has changed."
 *
 * — and this form disables those inputs rather than letting someone type into a
 * box whose contents will be rejected. Everything else stays editable at every
 * status, which is the point: a phone number is not an identity.
 */
import { useState } from 'react';
import { Banner, Card, FieldError } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation } from '@/lib/client/use-resource';
import { GST_STATE_CODES } from '@/lib/validate';

export interface EditableVendor {
  id: number;
  legal_name: string;
  vendor_type: string;
  pan: string;
  gstin: string | null;
  state_code: string;
  address: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  msme_number: string | null;
  status: string;
}

export function EditVendorForm({
  vendor,
  onClose,
  onSaved,
}: {
  vendor: EditableVendor;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [legalName, setLegalName] = useState(vendor.legal_name);
  const [vendorType, setVendorType] = useState(vendor.vendor_type);
  const [pan, setPan] = useState(vendor.pan);
  const [gstin, setGstin] = useState(vendor.gstin ?? '');
  const [stateCode, setStateCode] = useState(vendor.state_code);
  const [address, setAddress] = useState(vendor.address);
  const [contactName, setContactName] = useState(vendor.contact_name ?? '');
  const [contactEmail, setContactEmail] = useState(vendor.contact_email ?? '');
  const [contactPhone, setContactPhone] = useState(vendor.contact_phone ?? '');
  const [msme, setMsme] = useState(vendor.msme_number ?? '');

  /** Frozen once approved — see the note at the top. */
  const identityFrozen = vendor.status === 'VENDOR_APPROVED';

  const save = useMutation(
    async () =>
      api.patch(`/api/vendors/${vendor.id}`, {
        legal_name: legalName,
        vendor_type: vendorType,
        // Sent unchanged when frozen, so the service sees no identity change.
        pan: pan.toUpperCase().replace(/[\s-]/g, ''),
        gstin: gstin.trim() ? gstin.toUpperCase().replace(/[\s-]/g, '') : null,
        state_code: stateCode,
        address,
        contact_name: contactName.trim() || null,
        contact_email: contactEmail.trim() || null,
        contact_phone: contactPhone.trim() || null,
        msme_number: msme.trim() || null,
      }),
    { onDone: onSaved, successMessage: 'Vendor updated.' },
  );

  const err = (field: string) => (save.fieldError?.field === field ? save.fieldError.message : null);
  const ready = legalName.trim().length > 0 && address.trim().length > 0;

  return (
    <Card title="Edit vendor" pad label="Edit vendor">
      {identityFrozen && (
        <div className="banner info" style={{ marginTop: 12 }}>
          <span>
            This vendor is approved, so PAN, GSTIN and state are frozen — live purchase orders reference them. Block the
            record and create a new one if their registration has genuinely changed.
          </span>
        </div>
      )}

      <div className="grid g3" style={{ marginTop: 12 }}>
        <div className="field" style={{ gridColumn: '1/-1' }}>
          <label htmlFor="ev-name">Legal name</label>
          <input
            id="ev-name"
            className="inp"
            value={legalName}
            onChange={e => setLegalName(e.target.value)}
            aria-invalid={!!err('legal_name')}
          />
          {err('legal_name') && <FieldError id="ev-name-err">{err('legal_name')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="ev-type">Type</label>
          {/* Free text in the schema, not an enum — a select here would invent
              a vocabulary the database does not have. */}
          <input
            id="ev-type"
            className="inp"
            value={vendorType}
            onChange={e => setVendorType(e.target.value)}
            list="ev-type-options"
          />
          <datalist id="ev-type-options">
            {['COMPANY', 'LLP', 'PARTNERSHIP', 'PROPRIETORSHIP', 'INDIVIDUAL'].map(t => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>

        <div className="field">
          <label htmlFor="ev-pan">PAN</label>
          <input
            id="ev-pan"
            className="inp mono"
            value={pan}
            onChange={e => setPan(e.target.value)}
            disabled={identityFrozen}
            aria-invalid={!!err('pan')}
            maxLength={12}
          />
          <span className="sub">{err('pan') ?? (identityFrozen ? 'Frozen on an approved vendor.' : 'Ten characters.')}</span>
        </div>

        <div className="field">
          <label htmlFor="ev-state">State</label>
          <select
            id="ev-state"
            className="inp"
            value={stateCode}
            onChange={e => setStateCode(e.target.value)}
            disabled={identityFrozen}
          >
            {Object.entries(GST_STATE_CODES).map(([code, name]) => (
              <option key={code} value={code}>
                {code} · {name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ev-gstin">GSTIN</label>
          <input
            id="ev-gstin"
            className="inp mono"
            value={gstin}
            onChange={e => setGstin(e.target.value)}
            disabled={identityFrozen}
            aria-invalid={!!err('gstin')}
            maxLength={18}
          />
          <span className="sub">
            {err('gstin') ?? (identityFrozen ? 'Frozen on an approved vendor.' : 'Blank for an unregistered vendor.')}
          </span>
        </div>

        <div className="field">
          <label htmlFor="ev-msme">MSME number</label>
          <input id="ev-msme" className="inp" value={msme} onChange={e => setMsme(e.target.value)} />
        </div>

        <div className="field" style={{ gridColumn: '1/-1' }}>
          <label htmlFor="ev-address">Address</label>
          <textarea
            id="ev-address"
            className="inp"
            style={{ minHeight: 64 }}
            value={address}
            onChange={e => setAddress(e.target.value)}
            aria-invalid={!!err('address')}
          />
        </div>

        <div className="field">
          <label htmlFor="ev-contact">Contact name</label>
          <input id="ev-contact" className="inp" value={contactName} onChange={e => setContactName(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="ev-email">Contact email</label>
          <input
            id="ev-email"
            className="inp"
            type="email"
            value={contactEmail}
            onChange={e => setContactEmail(e.target.value)}
            aria-invalid={!!err('contact_email')}
          />
          {err('contact_email') && <FieldError id="ev-email-err">{err('contact_email')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="ev-phone">Contact phone</label>
          <input
            id="ev-phone"
            className="inp"
            value={contactPhone}
            onChange={e => setContactPhone(e.target.value)}
            aria-invalid={!!err('contact_phone')}
          />
          {err('contact_phone') && <FieldError id="ev-phone-err">{err('contact_phone')}</FieldError>}
        </div>
      </div>

      {save.error && (
        <div className="banner bad" style={{ marginTop: 12 }} role="alert">
          {save.error}
        </div>
      )}

      <div className="seg" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" className="btn" onClick={onClose} disabled={save.busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || save.busy}
          onClick={() => void save.run(undefined)}
        >
          {save.busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </Card>
  );
}
