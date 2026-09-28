'use client';

/**
 * Add a vendor.
 *
 * Client-side checks mirror the server's so the user sees a problem before
 * submitting, but the server decides — §31. Anything the server refuses with a
 * `field` is attached to that input rather than dropped into a banner.
 *
 * Bank details are optional here and go through the same maker-checker route as
 * the vendor detail screen: proposed PENDING, approved by someone else. They
 * are a SECOND call, because the account row needs a vendor_id that does not
 * exist until the vendor is saved — so the two cannot be one transaction, and
 * the form says plainly when the vendor was created but the account was not.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, FieldError } from '@/components/ui';
import { api, ApiFailure } from '@/lib/client/api';
import { useMutation } from '@/lib/client/use-resource';
import { GST_STATE_CODES } from '@/lib/validate';
import { VendorKyc, KYC_SLOTS, KYC_ACCEPT, kycFileProblem, humanSize } from '@/app/(app)/vendors/VendorKyc';

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

interface Bank {
  account_number: string;
  ifsc: string;
  beneficiary_name: string;
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

const EMPTY_BANK: Bank = { account_number: '', ifsc: '', beneficiary_name: '' };

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function NewVendorForm({
  onClose,
  onCreated,
  granted,
}: {
  onClose: () => void;
  onCreated: () => void;
  granted: string[];
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [bank, setBank] = useState<Bank>(EMPTY_BANK);
  /** Set once the vendor row exists, so a failed bank call cannot be retried into a duplicate vendor. */
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [bankFailure, setBankFailure] = useState<string | null>(null);
  /**
   * KYC files chosen before the vendor exists. A document row needs an
   * entity_id, so these are held in the browser and uploaded the moment the
   * vendor is created — the fields belong where the user is filling the form,
   * not on a screen they have to go and find afterwards.
   */
  const [kyc, setKyc] = useState<Record<string, File>>({});
  const [kycProblem, setKycProblem] = useState<string | null>(null);
  const [kycFailures, setKycFailures] = useState<{ label: string; message: string }[]>([]);
  const router = useRouter();

  const canProposeBank = granted.includes('VENDOR.BANK_PROPOSE');

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => ({ ...d, [key]: value }));
  const setBankField = <K extends keyof Bank>(key: K, value: Bank[K]) => setBank(b => ({ ...b, [key]: value }));

  function stageKyc(docType: string, file: File | null) {
    setKycProblem(null);
    if (!file) {
      setKyc(k => {
        const next = { ...k };
        delete next[docType];
        return next;
      });
      return;
    }
    // Refuse it here rather than after a vendor has been created for it.
    const problem = kycFileProblem(file);
    if (problem) {
      setKycProblem(`${KYC_SLOTS.find(s => s.type === docType)?.label}: ${problem}`);
      return;
    }
    setKyc(k => ({ ...k, [docType]: file }));
  }

  // Normalised the same way the server will, so the preview matches what is stored.
  const pan = draft.pan.toUpperCase().replace(/[\s-]/g, '');
  const gstin = draft.gstin.toUpperCase().replace(/[\s-]/g, '');
  const ifsc = bank.ifsc.toUpperCase().replace(/[\s-]/g, '');
  const accountDigits = bank.account_number.replace(/[\s-]/g, '');

  const panLooksWrong = pan.length > 0 && !PAN_RE.test(pan);
  const gstinPanMismatch = gstin.length === 15 && PAN_RE.test(pan) && gstin.slice(2, 12) !== pan;
  const gstinStateMismatch = gstin.length >= 2 && gstin.slice(0, 2) !== draft.state_code;

  // All three bank fields together, or none of them. A half-filled account is
  // the one thing that must not reach the server, because the vendor would be
  // created and the account refused.
  const bankTouched = Boolean(accountDigits || ifsc || bank.beneficiary_name.trim());
  const accountLooksWrong = accountDigits.length > 0 && !/^[0-9]{6,20}$/.test(accountDigits);
  const ifscLooksWrong = ifsc.length > 0 && !IFSC_RE.test(ifsc);
  const bankComplete = /^[0-9]{6,20}$/.test(accountDigits) && IFSC_RE.test(ifsc) && Boolean(bank.beneficiary_name.trim());
  const bankPartial = bankTouched && !bankComplete;

  const mutation = useMutation<{ draft: Draft; bank: Bank | null; kyc: Record<string, File> }>(
    async values => {
      setBankFailure(null);

      // The vendor first — the account row cannot exist without its id.
      const created = createdId
        ? { id: createdId }
        : await api.post<{ id: number }>('/api/vendors', values.draft);
      setCreatedId(created.id);

      if (values.bank) {
        try {
          await api.post(`/api/vendors/${created.id}/bank`, values.bank);
        } catch (err) {
          // The vendor exists. Saying "could not create vendor" would be a lie,
          // and retrying the whole form would create a second one.
          setBankFailure(
            err instanceof ApiFailure || err instanceof Error
              ? err.message
              : 'The bank details could not be saved.',
          );
          throw err;
        }
      }

      // KYC last: the vendor and its bank details are the record. A document
      // that fails to attach is recoverable in place, so it must not throw and
      // make the whole thing look like it failed.
      const staged = Object.entries(values.kyc);
      if (staged.length > 0) {
        const failures: { label: string; message: string }[] = [];

        for (const [docType, file] of staged) {
          const form = new FormData();
          form.set('entity_type', 'VENDOR');
          form.set('entity_id', String(created.id));
          form.set('doc_type', docType);
          form.set('file', file);

          try {
            // Not through lib/client/api: multipart needs the browser's own boundary.
            const res = await fetch('/api/documents', { method: 'POST', body: form });
            const body = await res.json();
            if (!body.ok) throw new Error(body.error?.message ?? 'That upload failed.');
          } catch (e) {
            failures.push({
              label: KYC_SLOTS.find(sl => sl.type === docType)?.label ?? docType,
              message: e instanceof Error ? e.message : 'That upload failed.',
            });
          }
        }
        setKycFailures(failures);
      }

      router.prefetch(`/vendors/${created.id}`);
    },
    {
      // Deliberately says nothing about the KYC files: this string is fixed
      // before the uploads run, so any count in it would be a guess. The panel
      // below reports what actually landed, slot by slot.
      successMessage: bankComplete
        ? 'Vendor created as a draft. Bank details sent for approval.'
        : 'Vendor created as a draft.',
      // Deliberately no onDone: the panel stays open on the KYC step. The
      // register is refreshed when the user closes it.
    },
  );

  const ready =
    draft.legal_name.trim() && PAN_RE.test(pan) && draft.address.trim() && !gstinPanMismatch && !bankPartial;

  const fieldMessage = (field: string) =>
    mutation.fieldError?.field === field ? mutation.fieldError.message : null;

  /**
   * A document needs an entity_id, so KYC cannot be uploaded until the vendor
   * row exists. Rather than send the user away to a second screen, the form
   * becomes the KYC step once the vendor is saved.
   */
  // `mutation.busy` matters: createdId is set as soon as the vendor row exists,
  // but the KYC uploads run after it. Switching views on createdId alone mounts
  // the panel mid-upload, where it fetches an empty list and never looks again —
  // so the documents land but the screen says none are held.
  if (createdId !== null && !bankFailure && !mutation.busy) {
    return (
      <Card
        title="Vendor created"
        subtitle={`${draft.legal_name.trim()} is a draft. Attach its KYC documents now, or close and do it later.`}
        pad
        label="Vendor created"
      >
        {mutation.success && (
          <div className="banner ok" style={{ marginTop: 12 }} role="status">
            {mutation.success}
          </div>
        )}

        {kycFailures.length > 0 && (
          <div className="banner warn" style={{ marginTop: 12 }} role="alert">
            <span>
              <b>Some documents did not attach.</b>{' '}
              {kycFailures.map(f => `${f.label} — ${f.message}`).join(' ')}
            </span>
            <span>The vendor is saved. Choose those files again below.</span>
          </div>
        )}

        <h3 style={{ margin: '18px 0 10px', fontSize: 15 }}>KYC documents</h3>
        <VendorKyc vendorId={createdId} canAttach bare />

        <div className="seg" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn" onClick={onCreated}>
            Done
          </button>
          <button type="button" className="btn btn-primary" onClick={() => router.push(`/vendors/${createdId}`)}>
            Open the vendor
          </button>
        </div>
      </Card>
    );
  }

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

      {canProposeBank ? (
        <>
          <h3 style={{ margin: '20px 0 0', fontSize: 15 }}>Bank details (optional)</h3>
          <p className="sub" style={{ margin: '2px 0 0' }}>
            Proposed here, approved by someone else before any payment can be released. Leave blank to add them later.
          </p>

          <div className="grid g3" style={{ marginTop: 12 }}>
            <div className="field">
              <label htmlFor="nv-bank-acct">Account number</label>
              <input
                id="nv-bank-acct"
                className="inp mono"
                value={bank.account_number}
                onChange={e => setBankField('account_number', e.target.value)}
                aria-invalid={accountLooksWrong || !!fieldMessage('account_number')}
                aria-describedby="nv-bank-acct-hint"
                autoComplete="off"
                inputMode="numeric"
              />
              <span id="nv-bank-acct-hint" className={`sub ${accountLooksWrong ? 't-bad' : ''}`}>
                {fieldMessage('account_number') ??
                  (accountLooksWrong
                    ? 'An account number is 6 to 20 digits.'
                    : 'Encrypted on save; only the last four digits are ever shown.')}
              </span>
            </div>

            <div className="field">
              <label htmlFor="nv-bank-ifsc">IFSC</label>
              <input
                id="nv-bank-ifsc"
                className="inp mono"
                value={bank.ifsc}
                onChange={e => setBankField('ifsc', e.target.value)}
                aria-invalid={ifscLooksWrong || !!fieldMessage('ifsc')}
                aria-describedby="nv-bank-ifsc-hint"
                placeholder="HDFC0001234"
                maxLength={13}
              />
              <span id="nv-bank-ifsc-hint" className={`sub ${ifscLooksWrong ? 't-bad' : ''}`}>
                {fieldMessage('ifsc') ??
                  (ifscLooksWrong ? 'Four letters, a zero, then six more.' : 'Eleven characters.')}
              </span>
            </div>

            <div className="field">
              <label htmlFor="nv-bank-benef">Beneficiary name</label>
              <input
                id="nv-bank-benef"
                className="inp"
                value={bank.beneficiary_name}
                onChange={e => setBankField('beneficiary_name', e.target.value)}
                aria-invalid={!!fieldMessage('beneficiary_name')}
                aria-describedby="nv-bank-benef-hint"
              />
              <span id="nv-bank-benef-hint" className="sub">
                {fieldMessage('beneficiary_name') ?? 'As printed on the bank account.'}
              </span>
            </div>
          </div>

          {bankPartial && (
            <div className="banner warn" style={{ marginTop: 12 }}>
              <span>
                Bank details need all three fields — account number, IFSC and beneficiary name. Complete them, or clear
                them to add the account later.
              </span>
            </div>
          )}
        </>
      ) : (
        <p className="sub" style={{ marginTop: 16, marginBottom: 0 }}>
          Bank details are added by Accounts or a Buyer, on the vendor once it exists.
        </p>
      )}

      <h3 style={{ margin: '20px 0 0', fontSize: 15 }}>KYC documents (optional)</h3>
      <p className="sub" style={{ margin: '2px 0 0' }}>
        Chosen now, attached the moment the vendor is created. PDF or image, up to 10 MB each.
      </p>

      {kycProblem && (
        <div className="banner bad" style={{ marginTop: 12 }} role="alert">
          {kycProblem}
        </div>
      )}

      <div className="col" style={{ gap: 10, marginTop: 12 }}>
        {KYC_SLOTS.map(slot => {
          const file = kyc[slot.type];
          return (
            <div key={slot.type} className="kyc-slot">
              <span className={`kyc-dot ${file ? 'is-held' : ''}`} aria-hidden="true" />

              <div style={{ minWidth: 0 }}>
                <div className="b">{slot.label}</div>
                <div className="sub">
                  {file ? `${file.name} · ${humanSize(file.size)} · attaches on create` : slot.hint}
                </div>
              </div>

              <div className="seg" style={{ gap: 6, margin: 0 }}>
                {file && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => stageKyc(slot.type, null)}
                    aria-label={`Remove the ${slot.label}`}
                  >
                    Remove
                  </button>
                )}
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor={`nv-kyc-${slot.type}`} className="btn btn-sm kyc-choose">
                    {file ? 'Change' : 'Choose file'}
                  </label>
                  <input
                    id={`nv-kyc-${slot.type}`}
                    type="file"
                    className="kyc-file"
                    accept={KYC_ACCEPT}
                    aria-label={`Choose the ${slot.label}`}
                    onChange={e => {
                      stageKyc(slot.type, e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* The vendor is saved and the account is not — two calls, one of which failed. */}
      {createdId !== null && bankFailure && (
        <div className="banner warn" style={{ marginTop: 12 }} role="alert">
          <span>
            <b>The vendor was created.</b> The bank details were not: {bankFailure} Nothing is lost — open the vendor
            and add them there.
          </span>
        </div>
      )}

      {mutation.error && !bankFailure && (
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
        <button
          type="button"
          className="btn"
          onClick={createdId !== null ? onCreated : onClose}
          disabled={mutation.busy}
        >
          {createdId !== null && bankFailure ? 'Close' : 'Cancel'}
        </button>

        {createdId !== null && bankFailure ? (
          <button type="button" className="btn btn-primary" onClick={() => router.push(`/vendors/${createdId}`)}>
            Open the vendor
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || mutation.busy}
            onClick={() =>
              mutation.run({
                draft: { ...draft, pan, gstin },
                bank: bankComplete
                  ? { account_number: accountDigits, ifsc, beneficiary_name: bank.beneficiary_name.trim() }
                  : null,
                kyc,
              })
            }
          >
            {mutation.busy ? 'Saving…' : 'Create vendor'}
          </button>
        )}
      </div>
    </Card>
  );
}
