'use client';

/**
 * The user picker.
 *
 * Shows each user's roles and sites, because the commonest reason a screen is
 * missing after signing in is a missing grant, and seeing "no roles" here saves
 * a trip through /no-access to work that out.
 */
import { useState } from 'react';
import { Card, Chip, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useResource } from '@/lib/client/use-resource';
import { ROLE_LABELS } from '@/lib/labels';
import type { RoleCode } from '@/lib/auth/permissions';

interface LocalUser {
  email: string;
  fullName: string;
  status: string;
  roles: string[];
  sites: string[];
}

export function SignInPicker() {
  const { data, loading, error, reload } = useResource<{ users: LocalUser[] }>('/api/auth/local');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function signIn(email: string) {
    setBusy(email);
    setFailure(null);
    try {
      await api.post('/api/auth/local', { email });
      // A full navigation, not a router push: the session cookie has to be
      // present on the next server render for the shell to see it.
      window.location.href = '/';
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not sign in.');
      setBusy(null);
    }
  }

  if (loading) return <LoadingState rows={4} label="Loading users" />;

  if (error) {
    return (
      <ErrorState
        title="Could not reach the database"
        message={error}
        retry={
          <button type="button" className="btn" onClick={reload}>
            Try again
          </button>
        }
      />
    );
  }

  const users = data?.users ?? [];

  if (users.length === 0) {
    return (
      <EmptyState title="No users yet">
        Create the first administrator, then reload this page:
        <br />
        <code className="mono" style={{ fontSize: 12 }}>
          npm run bootstrap:admin -- you@crystalgroup.in --site DHU --name Dhulagarh --state 19 --gstin &lt;GSTIN&gt;
          --tally &lt;cost centre&gt;
        </code>
      </EmptyState>
    );
  }

  return (
    <>
      {failure && (
        <div className="banner bad" role="alert">
          {failure}
        </div>
      )}

      <Card label="Sign in as">
        {users.map(u => {
          const inactive = u.status !== 'ACTIVE';
          const noRoles = u.roles.length === 0;

          return (
            <button
              key={u.email}
              type="button"
              className="list-btn"
              disabled={inactive || busy !== null}
              onClick={() => signIn(u.email)}
              style={inactive ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
            >
              <span className="top">
                <span className="b">{u.fullName}</span>
                {inactive ? (
                  <Chip kind="neutral">{u.status}</Chip>
                ) : busy === u.email ? (
                  <Chip kind="info">Signing in…</Chip>
                ) : null}
              </span>
              <span className="sub">{u.email}</span>
              <span className="sub">
                {noRoles ? (
                  <span className="t-warn">No roles granted — will land on “No access”</span>
                ) : (
                  <>
                    {u.roles.map(r => ROLE_LABELS[r as RoleCode] ?? r).join(', ')}
                    {u.sites.length > 0 && ` · ${u.sites.join(', ')}`}
                  </>
                )}
              </span>
            </button>
          );
        })}
      </Card>

      <p className="sub" style={{ margin: 0 }}>
        Roles are granted per site in <b>Master data → user roles</b>, or with{' '}
        <code className="mono" style={{ fontSize: 12 }}>npm run bootstrap:admin</code>.
      </p>
    </>
  );
}
