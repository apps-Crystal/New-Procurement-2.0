'use client';

/**
 * Add a site.
 *
 * Two rules from the schema are surfaced live rather than only on save:
 * a GSTIN must begin with its state code (`sites_gstin_state`), and a site
 * cannot be activated without a Tally cost centre (`sites_active_needs_mapping`).
 * Both are still enforced server-side.
 */
import { useState } from 'react';
import { Card, FieldError } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation } from '@/lib/client/use-resource';
import { GST_STATE_CODES } from '@/lib/validate';
import { ENUMS } from '@/lib/enums';
import { label, SITE_TYPE_LABELS } from '@/lib/labels';

export function NewSiteForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [siteType, setSiteType] = useState('WAREHOUSE');
  const [address, setAddress] = useState('');
  const [stateCode, setStateCode] = useState('19');
  const [gstin, setGstin] = useState('');
  const [coldChain, setColdChain] = useState(false);
  const [tallyCostCentre, setTallyCostCentre] = useState('');
  const [activate, setActivate] = useState(false);

  const mutation = useMutation<Record<string, unknown>>(body => api.post('/api/master/sites', body), {
    successMessage: 'Site created.',
    onDone: onCreated,
  });

  const normalisedGstin = gstin.toUpperCase().replace(/[\s-]/g, '');
  const stateMismatch = normalisedGstin.length >= 2 && normalisedGstin.slice(0, 2) !== stateCode;
  const needsTally = activate && !tallyCostCentre.trim();

  const ready =
    code.trim().length >= 2 &&
    name.trim() &&
    address.trim() &&
    normalisedGstin.length === 15 &&
    !stateMismatch &&
    !needsTally;

  const fieldMessage = (field: string) => (mutation.fieldError?.field === field ? mutation.fieldError.message : null);

  return (
    <Card title="New site" subtitle="Sites are created inactive until their Tally cost centre is mapped" pad label="New site">
      <div className="grid g3" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="ns-code">Site code</label>
          <input
            id="ns-code"
            className="inp mono"
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="DHU"
            maxLength={12}
            aria-invalid={!!fieldMessage('code')}
          />
          <span className="sub">
            {fieldMessage('code') ?? 'Appears in every document number and cannot change once transacted.'}
          </span>
        </div>

        <div className="field">
          <label htmlFor="ns-name">Name</label>
          <input id="ns-name" className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="Dhulagarh" />
        </div>

        <div className="field">
          <label htmlFor="ns-type">Type</label>
          <select id="ns-type" className="inp" value={siteType} onChange={e => setSiteType(e.target.value)}>
            {ENUMS.site_type.map(t => (
              <option key={t} value={t}>
                {label(SITE_TYPE_LABELS, t)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ns-state">State</label>
          <select id="ns-state" className="inp" value={stateCode} onChange={e => setStateCode(e.target.value)}>
            {Object.entries(GST_STATE_CODES).map(([c, n]) => (
              <option key={c} value={c}>
                {c} · {n}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ns-gstin">GSTIN</label>
          <input
            id="ns-gstin"
            className="inp mono"
            value={gstin}
            onChange={e => setGstin(e.target.value)}
            placeholder="19AABCU9603R1ZX"
            maxLength={18}
            aria-invalid={stateMismatch || !!fieldMessage('gstin')}
          />
          <span className={`sub ${stateMismatch ? 't-bad' : ''}`}>
            {fieldMessage('gstin') ??
              (stateMismatch
                ? `A GSTIN starts with its state code — this one starts ${normalisedGstin.slice(0, 2)}, not ${stateCode}.`
                : 'Must begin with the state code above.')}
          </span>
        </div>

        <div className="field">
          <label htmlFor="ns-tally">Tally cost centre</label>
          <input
            id="ns-tally"
            className="inp mono"
            value={tallyCostCentre}
            onChange={e => setTallyCostCentre(e.target.value)}
            aria-invalid={needsTally || !!fieldMessage('tally_cost_centre')}
          />
          <span className={`sub ${needsTally ? 't-bad' : ''}`}>
            {fieldMessage('tally_cost_centre') ?? (needsTally ? 'Required to activate the site.' : 'Required before activation.')}
          </span>
        </div>

        <div className="field" style={{ gridColumn: '1/-1' }}>
          <label htmlFor="ns-addr">Address</label>
          <textarea id="ns-addr" className="inp" style={{ minHeight: 60 }} value={address} onChange={e => setAddress(e.target.value)} />
        </div>

        <div style={{ display: 'flex', gap: 18, alignItems: 'center', gridColumn: '1/-1', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={coldChain} onChange={e => setColdChain(e.target.checked)} style={{ width: 18, height: 18 }} />
            <span className="note">Cold-chain capable</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={activate} onChange={e => setActivate(e.target.checked)} style={{ width: 18, height: 18 }} />
            <span className="note">Activate immediately</span>
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
              site_type: siteType,
              address,
              state_code: stateCode,
              gstin: normalisedGstin,
              cold_chain_capable: coldChain,
              tally_cost_centre: tallyCostCentre || null,
              status: activate ? 'ACTIVE' : 'INACTIVE',
            })
          }
        >
          {mutation.busy ? 'Saving…' : 'Create site'}
        </button>
      </div>
    </Card>
  );
}
