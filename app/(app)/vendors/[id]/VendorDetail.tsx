'use client';

/**
 * Vendor detail — KYC, lifecycle, and bank maker-checker.
 *
 * The bank panel is the interesting part. Maker-checker is a rule the schema
 * enforced with `vba_maker_checker`, and the UI's job is to make it legible
 * rather than to enforce it: the approve button is hidden from the proposer,
 * but the server refuses them regardless (§31). The same goes for approving a
 * vendor you created.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Card, Chip, ErrorState, LoadingState, StatusChip, Tile, fmtDateTime } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { stateName } from '@/lib/validate';

interface Vendor {
  id: number;
  vendor_code: string;
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
  tally_ledger_ref: string | null;
  status: string;
  blocked_reason: string | null;
  created_by: number | null;
  approved_by: number | null;
  approved_at: string | null;
}

interface BankAccount {
  id: number;
  account_last4: string;
  ifsc: string;
  beneficiary_name: string;
  state: string;
  proposed_by: number;
  approved_by: number | null;
  approved_at: string | null;
  created_at: string;
}

interface Payload {
  vendor: Vendor;
  categories: number[];
  sites: number[];
  banks: BankAccount[];
}

export function VendorDetail({
  vendorId,
  granted,
  currentUserId,
}: {
  vendorId: number;
  granted: string[];
  currentUserId: number;
}) {
  const { data, loading, error, reload } = useResource<Payload>(`/api/vendors/${vendorId}`);

  if (loading) return <LoadingState rows={8} label="Loading vendor" />;
  if (error) {
    return (
      <ErrorState
        message={error}
        retry={
          <button type="button" className="btn" onClick={reload}>
            Try again
          </button>
        }
      />
    );
  }
  if (!data) return null;

  const { vendor, banks } = data;

  return (
    <>
      <div className="head" style={{ marginTop: -8 }}>
        <div>
          <div className="crumb">
            <Link href="/vendors">Vendor master</Link>
          </div>
          <h1 style={{ fontSize: 22 }}>
            {vendor.legal_name}
            <span className="docno">{vendor.vendor_code}</span>
            <StatusChip status={vendor.status} />
          </h1>
        </div>
        <LifecycleActions vendor={vendor} granted={granted} currentUserId={currentUserId} onDone={reload} />
      </div>

      {vendor.status === 'VENDOR_BLOCKED' && vendor.blocked_reason && (
        <div className="banner bad">
          <span>
            <b>Blocked.</b> {vendor.blocked_reason}
          </span>
          <span>This vendor cannot be selected on any purchase order.</span>
        </div>
      )}

      <div className="row">
        <div className="grow col">
          <Card title="Registration" pad label="Registration">
            <div className="grid g3" style={{ marginTop: 12 }}>
              <Tile label="PAN" value={<span className="mono">{vendor.pan}</span>} />
              <Tile
                label="GSTIN"
                value={<span className="mono">{vendor.gstin ?? '—'}</span>}
                hint={vendor.gstin ? undefined : 'Unregistered vendor'}
              />
              <Tile label="State" value={stateName(vendor.state_code)} hint={`Code ${vendor.state_code}`} />
              <Tile label="Type" value={vendor.vendor_type} />
              <Tile label="MSME" value={vendor.msme_number ?? '—'} />
              <Tile
                label="Tally ledger"
                value={<span className="mono">{vendor.tally_ledger_ref ?? '—'}</span>}
                hint={vendor.tally_ledger_ref ? undefined : 'Required before approval'}
              />
            </div>
            <p className="note" style={{ marginTop: 12, marginBottom: 0 }}>
              {vendor.address}
            </p>
            {vendor.status === 'VENDOR_APPROVED' && (
              <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
                PAN, GSTIN and state are frozen on an approved vendor. If their registration changes, block this record
                and create a new one.
              </p>
            )}
          </Card>

          <Card title="Contact" pad label="Contact">
            <div className="grid g3" style={{ marginTop: 12 }}>
              <Tile label="Name" value={vendor.contact_name ?? '—'} />
              <Tile label="Email" value={vendor.contact_email ?? '—'} />
              <Tile label="Phone" value={vendor.contact_phone ?? '—'} />
            </div>
          </Card>
        </div>

        <aside className="col side-w" style={{ width: 380, flexShrink: 0 }}>
          <BankPanel
            vendorId={vendorId}
            banks={banks}
            granted={granted}
            currentUserId={currentUserId}
            onDone={reload}
          />
        </aside>
      </div>
    </>
  );
}

// --- Lifecycle ------------------------------------------------------------------

function LifecycleActions({
  vendor,
  granted,
  currentUserId,
  onDone,
}: {
  vendor: Vendor;
  granted: string[];
  currentUserId: number;
  onDone: () => void;
}) {
  const [ledgerRef, setLedgerRef] = useState(vendor.tally_ledger_ref ?? '');
  const [reason, setReason] = useState('');
  const [blocking, setBlocking] = useState(false);

  const act = useMutation<{ action: string; reason?: string; tally_ledger_ref?: string }>(
    body => api.post(`/api/vendors/${vendor.id}/transition`, body),
    { onDone, successMessage: 'Updated.' },
  );

  // The creator cannot approve their own vendor. Hiding the button is courtesy;
  // the server refuses them either way.
  const isCreator = Number(vendor.created_by) === currentUserId;

  return (
    <div className="col" style={{ gap: 8, alignItems: 'flex-end' }}>
      <div className="seg">
        {vendor.status === 'VENDOR_DRAFT' && granted.includes('VENDOR.SUBMIT') && (
          <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => act.run({ action: 'submit' })}>
            Send for approval
          </button>
        )}

        {vendor.status === 'VENDOR_PENDING' && granted.includes('VENDOR.APPROVE') && !isCreator && (
          <>
            <input
              className="inp mono"
              style={{ width: 200 }}
              value={ledgerRef}
              onChange={e => setLedgerRef(e.target.value)}
              placeholder="Tally ledger ref"
              aria-label="Tally ledger reference"
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={act.busy || !ledgerRef.trim()}
              onClick={() => act.run({ action: 'approve', tally_ledger_ref: ledgerRef })}
            >
              Approve vendor
            </button>
          </>
        )}

        {vendor.status === 'VENDOR_APPROVED' && granted.includes('VENDOR.BLOCK') && (
          <button type="button" className="btn btn-danger" onClick={() => setBlocking(v => !v)}>
            Block
          </button>
        )}

        {vendor.status === 'VENDOR_BLOCKED' && granted.includes('VENDOR.UNBLOCK') && (
          <button type="button" className="btn" disabled={act.busy} onClick={() => act.run({ action: 'unblock' })}>
            Unblock
          </button>
        )}
      </div>

      {vendor.status === 'VENDOR_PENDING' && isCreator && (
        <span className="sub t-warn">You created this vendor, so someone else must approve it.</span>
      )}

      {blocking && (
        <div className="card pad col" style={{ gap: 8, width: 340 }}>
          <label htmlFor="blk-reason" className="lbl">
            Why is this vendor being blocked?
          </label>
          <textarea
            id="blk-reason"
            className="inp"
            style={{ minHeight: 60 }}
            value={reason}
            onChange={e => setReason(e.target.value)}
          />
          <div className="seg" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setBlocking(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={reason.trim().length < 4 || act.busy}
              onClick={() => act.run({ action: 'block', reason })}
            >
              Block vendor
            </button>
          </div>
        </div>
      )}

      {act.error && (
        <span className="err-text" role="alert">
          {act.error}
        </span>
      )}
    </div>
  );
}

// --- Bank maker-checker -------------------------------------------------------------

function BankPanel({
  vendorId,
  banks,
  granted,
  currentUserId,
  onDone,
}: {
  vendorId: number;
  banks: BankAccount[];
  granted: string[];
  currentUserId: number;
  onDone: () => void;
}) {
  const [proposing, setProposing] = useState(false);

  if (!granted.includes('VENDOR.BANK_VIEW')) {
    return (
      <Card title="Bank details" pad label="Bank details">
        <p className="note" style={{ margin: '12px 0 0' }}>
          Bank details are visible to Accounts and Finance only.
        </p>
      </Card>
    );
  }

  const live = banks.find(b => b.state === 'APPROVED');
  const pending = banks.find(b => b.state === 'PENDING');

  return (
    <>
      <Card title="Bank details" subtitle="Two people required" pad label="Bank details">
        {live ? (
          <div className="box" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="b mono">•••• {live.account_last4}</span>
              <Chip kind="ok">Live</Chip>
            </div>
            <span className="sub mono">{live.ifsc}</span>
            <span className="sub">{live.beneficiary_name}</span>
            <span className="sub">Approved {fmtDateTime(live.approved_at)}</span>
          </div>
        ) : (
          <p className="note" style={{ margin: '12px 0 0' }}>
            No approved bank account. Payments cannot be released until one is approved.
          </p>
        )}

        {pending && (
          <div className="box" style={{ marginTop: 10, borderColor: 'var(--warn)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="b mono">•••• {pending.account_last4}</span>
              <Chip kind="warn">Awaiting approval</Chip>
            </div>
            <span className="sub mono">{pending.ifsc}</span>
            <span className="sub">{pending.beneficiary_name}</span>
            <PendingActions
              vendorId={vendorId}
              account={pending}
              granted={granted}
              currentUserId={currentUserId}
              onDone={onDone}
            />
          </div>
        )}

        {!pending && granted.includes('VENDOR.BANK_PROPOSE') && (
          <button type="button" className="btn" style={{ marginTop: 12, width: '100%' }} onClick={() => setProposing(v => !v)}>
            {live ? 'Propose new bank details' : 'Add bank details'}
          </button>
        )}

        <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
          Account numbers are encrypted. Only the last four digits are ever shown, and they are never written to the
          audit trail.
        </p>
      </Card>

      {proposing && (
        <ProposeBankForm
          vendorId={vendorId}
          onClose={() => setProposing(false)}
          onDone={() => {
            setProposing(false);
            onDone();
          }}
        />
      )}
    </>
  );
}

function PendingActions({
  vendorId,
  account,
  granted,
  currentUserId,
  onDone,
}: {
  vendorId: number;
  account: BankAccount;
  granted: string[];
  currentUserId: number;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const act = useMutation<{ action: string; reason?: string }>(
    body => api.post(`/api/vendors/${vendorId}/bank/${account.id}`, body),
    { onDone },
  );

  // `vba_maker_checker` — the proposer is not offered the decision.
  const isProposer = Number(account.proposed_by) === currentUserId;

  if (isProposer) {
    return (
      <span className="sub t-warn" style={{ marginTop: 8 }}>
        You proposed these details, so someone else in Accounts or Finance must approve them.
      </span>
    );
  }

  if (!granted.includes('VENDOR.BANK_APPROVE')) {
    return (
      <span className="sub" style={{ marginTop: 8 }}>
        Waiting on Finance to approve.
      </span>
    );
  }

  return (
    <div className="col" style={{ gap: 8, marginTop: 10 }}>
      {!rejecting ? (
        <div className="seg">
          <button type="button" className="btn btn-sm btn-primary" disabled={act.busy} onClick={() => act.run({ action: 'approve' })}>
            Approve
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setRejecting(true)}>
            Reject
          </button>
        </div>
      ) : (
        <>
          <textarea
            className="inp"
            style={{ minHeight: 52 }}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Why are these details being rejected?"
            aria-label="Rejection reason"
          />
          <div className="seg">
            <button type="button" className="btn btn-sm" onClick={() => setRejecting(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={reason.trim().length < 4 || act.busy}
              onClick={() => act.run({ action: 'reject', reason })}
            >
              Confirm rejection
            </button>
          </div>
        </>
      )}
      {act.error && (
        <span className="err-text" role="alert">
          {act.error}
        </span>
      )}
      {/* vba_one_live — there is only ever one approved account per vendor. */}
      <span className="sub">Approving this retires the account currently in use.</span>
    </div>
  );
}

function ProposeBankForm({
  vendorId,
  onClose,
  onDone,
}: {
  vendorId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [account, setAccount] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [beneficiary, setBeneficiary] = useState('');

  const mutation = useMutation<{ account_number: string; ifsc: string; beneficiary_name: string }>(
    body => api.post(`/api/vendors/${vendorId}/bank`, body),
    { onDone, successMessage: 'Sent for approval.' },
  );

  const normalisedIfsc = ifsc.toUpperCase().replace(/[\s-]/g, '');
  const ifscLooksWrong = normalisedIfsc.length > 0 && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(normalisedIfsc);
  const digits = account.replace(/[\s-]/g, '');
  const ready = /^[0-9]{6,20}$/.test(digits) && !ifscLooksWrong && normalisedIfsc.length === 11 && beneficiary.trim();

  const fieldMessage = (field: string) => (mutation.fieldError?.field === field ? mutation.fieldError.message : null);

  return (
    <Card title="Propose bank details" pad label="Propose bank details">
      <div className="col" style={{ gap: 12, marginTop: 12 }}>
        <div className="field">
          <label htmlFor="bk-acct">Account number</label>
          <input
            id="bk-acct"
            className="inp mono"
            value={account}
            onChange={e => setAccount(e.target.value)}
            aria-invalid={!!fieldMessage('account_number')}
            autoComplete="off"
          />
          <span className="sub">{fieldMessage('account_number') ?? 'Encrypted on save; only the last four digits are stored readable.'}</span>
        </div>

        <div className="field">
          <label htmlFor="bk-ifsc">IFSC</label>
          <input
            id="bk-ifsc"
            className="inp mono"
            value={ifsc}
            onChange={e => setIfsc(e.target.value)}
            aria-invalid={ifscLooksWrong || !!fieldMessage('ifsc')}
            maxLength={13}
            placeholder="HDFC0001234"
          />
          <span className={`sub ${ifscLooksWrong ? 't-bad' : ''}`}>
            {fieldMessage('ifsc') ?? (ifscLooksWrong ? 'Four letters, a zero, then six more.' : 'Eleven characters.')}
          </span>
        </div>

        <div className="field">
          <label htmlFor="bk-benef">Beneficiary name</label>
          <input
            id="bk-benef"
            className="inp"
            value={beneficiary}
            onChange={e => setBeneficiary(e.target.value)}
            aria-invalid={!!fieldMessage('beneficiary_name')}
          />
        </div>

        {mutation.error && (
          <div className="banner bad" role="alert">
            {mutation.error}
          </div>
        )}

        <div className="seg" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={mutation.busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || mutation.busy}
            onClick={() => mutation.run({ account_number: digits, ifsc: normalisedIfsc, beneficiary_name: beneficiary })}
          >
            {mutation.busy ? 'Saving…' : 'Send for approval'}
          </button>
        </div>
      </div>
    </Card>
  );
}
