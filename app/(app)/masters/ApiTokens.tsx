'use client';

/**
 * API tokens — machine access to the same API the browser uses.
 *
 * The value is shown once, here, immediately after it is created, and never
 * again. Only its SHA-256 is stored, so there is no screen and no query that
 * could show it later — which is the point, and worth saying on the screen so
 * nobody closes the panel expecting to come back for it.
 */
import { useState } from 'react';
import { Banner, Card, EmptyState, ErrorState, LoadingState, fmtDateTime } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface TokenRow {
  id: number;
  name: string;
  prefix: string;
  read_only: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  user_email: string;
  user_name: string;
  created_by_email: string;
}

interface UserRow {
  id: number;
  email: string;
  full_name: string;
  grants: { role: string }[];
}

export function ApiTokens({ canManage }: { canManage: boolean }) {
  const { data, loading, error, reload } = useResource<TokenRow[]>('/api/master/tokens');
  const users = useResource<UserRow[]>('/api/master/users');

  const [creating, setCreating] = useState(false);
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [expires, setExpires] = useState('');
  /** Held only until the panel is closed. Never re-fetchable. */
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation<Record<string, unknown>>(
    async body => {
      const row = await api.post<{ token: string }>('/api/master/tokens', body);
      setIssued(row.token);
      return row;
    },
    { onDone: reload },
  );

  const revoke = useMutation<number>(id => api.del('/api/master/tokens', { id }), {
    successMessage: 'Token revoked.',
    onDone: reload,
  });

  if (loading) return <LoadingState rows={4} label="Loading API tokens" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }

  const rows = data ?? [];
  const live = rows.filter(t => !t.revoked_at);

  return (
    <>
      {canManage && (
        <div className="seg" style={{ marginBottom: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => { setCreating(v => !v); setIssued(null); }}>
            {creating ? 'Close' : 'Issue a token'}
          </button>
        </div>
      )}

      {issued && (
        <Card title="Copy this now" pad label="New token">
          <Banner kind="warn">
            This is the only time this value will ever be shown. Only its hash is stored, so it cannot be recovered — if
            it is lost, revoke it and issue another.
          </Banner>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="tok-value">Token</label>
            <input id="tok-value" className="inp mono" readOnly value={issued} onFocus={e => e.currentTarget.select()} />
          </div>
          <div className="seg" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(issued).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="btn" onClick={() => { setIssued(null); setCreating(false); }}>
              Done
            </button>
          </div>
          <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
            Use it as <span className="mono">Authorization: Bearer &lt;token&gt;</span> against any route under{' '}
            <span className="mono">/api</span>.
          </p>
        </Card>
      )}

      {creating && !issued && (
        <Card title="Issue an API token" pad label="Issue a token">
          <p className="sub" style={{ marginTop: 0 }}>
            A token acts as the person you choose. It can do what they can do and nothing more, at the sites they hold a
            role at — so choose the narrowest account that does the job.
          </p>

          <div className="grid g3" style={{ marginTop: 12 }}>
            <div className="field">
              <label htmlFor="tok-user">Acts as</label>
              <select id="tok-user" className="inp" value={userId} onChange={e => setUserId(e.target.value)}>
                <option value="">Choose a person…</option>
                {(users.data ?? []).map(u => (
                  <option key={u.id} value={u.id}>
                    {u.full_name === u.email ? u.email : `${u.full_name} · ${u.email}`}
                    {u.grants.length === 0 ? ' — no roles' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="tok-name">What it is for</label>
              <input
                id="tok-name"
                className="inp"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Tally nightly export"
                maxLength={80}
              />
            </div>

            <div className="field">
              <label htmlFor="tok-expires">Expires (optional)</label>
              <input id="tok-expires" type="date" className="inp" value={expires} onChange={e => setExpires(e.target.value)} />
            </div>
          </div>

          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
            <input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2 }} />
            <span className="note">
              Read-only — the token may GET and nothing else.
              <br />
              <span className="sub">
                Leave this on unless the integration genuinely has to write. It is the difference between a leaked
                credential that is embarrassing and one that raises purchase orders.
              </span>
            </span>
          </label>

          {create.error && <Banner kind="bad">{create.error}</Banner>}

          <div className="seg" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button type="button" className="btn" onClick={() => setCreating(false)} disabled={create.busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!userId || name.trim().length < 3 || create.busy}
              onClick={() =>
                void create.run({
                  user_id: Number(userId),
                  name,
                  read_only: readOnly,
                  expires_at: expires || null,
                })
              }
            >
              {create.busy ? 'Issuing…' : 'Issue token'}
            </button>
          </div>
        </Card>
      )}

      {revoke.error && <Banner kind="bad">{revoke.error}</Banner>}

      {rows.length === 0 ? (
        <EmptyState title="No API tokens">
          Nothing outside a browser can reach this system yet. A token lets a script, an integration or another
          application call the same API the screens use.
        </EmptyState>
      ) : (
        <Card label="API tokens" title="API tokens" subtitle={`${live.length} live of ${rows.length}`}>
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: '1.4fr 1.3fr 130px 1fr 110px' }}>
              <div>Token</div>
              <div>Acts as</div>
              <div>Access</div>
              <div>Used</div>
              <div />
            </div>
            {rows.map(t => (
              <div className="tr" style={{ gridTemplateColumns: '1.4fr 1.3fr 130px 1fr 110px' }} key={t.id}>
                <div>
                  <div className="b">{t.name}</div>
                  <div className="sub mono" style={{ fontSize: 11 }}>{t.prefix}…</div>
                </div>
                <div>
                  <div>{t.user_name}</div>
                  <div className="sub">{t.user_email}</div>
                </div>
                <div className="sub">
                  {t.revoked_at ? (
                    <span className="t-bad">Revoked</span>
                  ) : t.expires_at && new Date(t.expires_at) <= new Date() ? (
                    <span className="t-warn">Expired</span>
                  ) : t.read_only ? (
                    'Read only'
                  ) : (
                    <span className="t-warn">Read and write</span>
                  )}
                </div>
                <div className="sub">
                  {t.last_used_at ? fmtDateTime(t.last_used_at) : 'never'}
                  {t.expires_at && !t.revoked_at && (
                    <div className="sub">expires {String(t.expires_at).slice(0, 10)}</div>
                  )}
                </div>
                <div>
                  {canManage && !t.revoked_at && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={revoke.busy}
                      aria-label={`Revoke the token ${t.name}`}
                      onClick={() => void revoke.run(t.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="pad sub" style={{ borderTop: '1px solid var(--line-2)' }}>
            A revoked token stops working immediately and is kept on the list — a credential that existed and was used
            is part of the history. Tokens are never widened by the development access switches.
          </div>
        </Card>
      )}
    </>
  );
}
