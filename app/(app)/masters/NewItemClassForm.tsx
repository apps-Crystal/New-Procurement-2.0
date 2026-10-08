'use client';

/**
 * Add an item class.
 *
 * A class is not a category — it is the behaviour every item in it inherits at
 * receiving. The temperature band decides whether a reefer reading is in
 * tolerance at the gate, and whether a cold-chain breach can be accepted away
 * at QC. The data-logger flag decides whether the logger file must be attached
 * to the gate inward before a verdict can be submitted at all.
 *
 * So the band is required the moment cold chain is ticked, and a CHECK
 * constraint says the same thing in the schema — this form states it early
 * rather than letting the database refuse the save.
 */
import { useState } from 'react';
import { Card, FieldError } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation } from '@/lib/client/use-resource';

export function NewItemClassForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [coldChain, setColdChain] = useState(false);
  const [tempMin, setTempMin] = useState('');
  const [tempMax, setTempMax] = useState('');
  const [needsLogger, setNeedsLogger] = useState(false);

  const mutation = useMutation<Record<string, unknown>>(
    body => api.post('/api/master/item-classes', body),
    { successMessage: 'Item class created.', onDone: onCreated },
  );

  const fieldMessage = (field: string) =>
    mutation.fieldError?.field === field ? mutation.fieldError.message : null;

  /**
   * Why the band is checked here too: item_classes_temp refuses a cold-chain
   * class without a valid band, and a form that only finds out on save makes
   * the database sound broken rather than the entry incomplete.
   */
  const bandProblem =
    !coldChain ? null
    : tempMin.trim() === '' || tempMax.trim() === '' ? 'A cold-chain class needs both ends of its temperature band.'
    : Number(tempMin) >= Number(tempMax) ? 'The minimum has to be below the maximum.'
    : null;

  const ready = code.trim().length >= 2 && name.trim().length > 0 && bandProblem === null;

  return (
    <Card title="New item class" pad label="New item class">
      <div className="grid g3" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="nic-code">Class code</label>
          <input
            id="nic-code"
            className="inp mono"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            placeholder="CHL"
            maxLength={16}
            aria-invalid={!!fieldMessage('code')}
          />
          {fieldMessage('code') && <FieldError id="nic-code-err">{fieldMessage('code')}</FieldError>}
        </div>

        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label htmlFor="nic-name">Description</label>
          <input
            id="nic-name"
            className="inp"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Chilled (2C to 8C)"
            maxLength={120}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginTop: 4 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={coldChain}
            onChange={e => setColdChain(e.target.checked)}
            style={{ width: 18, height: 18, marginTop: 2 }}
          />
          <span className="note">
            Cold chain — goods in this class carry a temperature band.
            <br />
            <span className="sub">
              The band is checked against the reefer reading at the gate, and a breach cannot be
              accepted at QC without a Site Manager&rsquo;s concession.
            </span>
          </span>
        </label>
      </div>

      {coldChain && (
        <div className="grid g3" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="nic-min">Minimum °C</label>
            <input
              id="nic-min"
              className="inp mono"
              value={tempMin}
              onChange={e => setTempMin(e.target.value)}
              inputMode="decimal"
              placeholder="-25"
            />
          </div>
          <div className="field">
            <label htmlFor="nic-max">Maximum °C</label>
            <input
              id="nic-max"
              className="inp mono"
              value={tempMax}
              onChange={e => setTempMax(e.target.value)}
              inputMode="decimal"
              placeholder="-18"
            />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', marginTop: 10 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={needsLogger}
            onChange={e => setNeedsLogger(e.target.checked)}
            style={{ width: 18, height: 18, marginTop: 2 }}
          />
          <span className="note">
            Requires a data logger.
            <br />
            <span className="sub">
              The logger file must be attached to the gate inward before QC can record a verdict. A
              reefer reading is one moment; the logger is the journey.
            </span>
          </span>
        </label>
      </div>

      {bandProblem && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          {bandProblem}
        </div>
      )}

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
              is_cold_chain: coldChain,
              temp_min_c: coldChain ? tempMin : null,
              temp_max_c: coldChain ? tempMax : null,
              requires_data_logger: needsLogger,
            })
          }
        >
          {mutation.busy ? 'Saving…' : 'Create item class'}
        </button>
      </div>
    </Card>
  );
}
