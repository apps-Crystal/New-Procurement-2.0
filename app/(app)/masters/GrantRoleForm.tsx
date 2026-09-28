'use client';

/**
 * Grant a role to someone, at a site.
 *
 * A role is always held AT a site — `rolesAt(principal, siteId)` is what every
 * permission check runs through, so a grant with no site would authorise
 * nothing. The only exceptions are CG_ADM and CG_DIR, which are group-wide by
 * definition; they are still recorded against a site row, and the permission
 * layer widens them.
 *
 * The role list is deliberately plain. Segregation of duties is enforced on the
 * server at the moment of the action, not by hiding combinations here — two
 * roles that conflict can both be held, and the conflicting STEP is what gets
 * refused. Warning about it up front is honest; pretending it cannot be done
 * would be wrong, because on a small site it often has to be.
 */
import { useState } from 'react';
import { Card, FieldError } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { ROLE_LABELS } from '@/lib/labels';
import { ENUMS } from '@/lib/enums';
import type { RoleCode } from '@/lib/auth/permissions';

interface UserRow {
  id: number;
  email: string;
  full_name: string;
  status: string;
  grants: { site_id: number; site_code: string; role: RoleCode }[];
}

interface SiteRow {
  id: number;
  code: string;
  name: string;
  status: string;
}

/** Group-wide by definition — the site on the row does not limit them. */
const GROUP_WIDE: RoleCode[] = ['CG_ADM', 'CG_DIR'];

export function GrantRoleForm({ onClose, onGranted }: { onClose: () => void; onGranted: () => void }) {
  const { data: users, loading: loadingUsers } = useResource<UserRow[]>('/api/master/users');
  const { data: sites, loading: loadingSites } = useResource<SiteRow[]>('/api/master/sites');

  const [userId, setUserId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [role, setRole] = useState<RoleCode | ''>('');

  const mutation = useMutation<Record<string, unknown>>(body => api.post('/api/master/user-roles', body), {
    successMessage: 'Role granted.',
    onDone: onGranted,
  });

  const user = (users ?? []).find(u => String(u.id) === userId);
  const ready = userId && siteId && role;
  const fieldMessage = (field: string) => (mutation.fieldError?.field === field ? mutation.fieldError.message : null);

  // Already held? Granting again is harmless but pointless, and saying so is
  // more use than letting them press a button that changes nothing.
  const alreadyHeld =
    !!user && !!role && user.grants.some(g => g.role === role && String(g.site_id) === siteId);

  return (
    <Card title="Grant a role" pad label="Grant a role">
      <div className="grid g3" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="gr-user">Person</label>
          <select
            id="gr-user"
            className="inp"
            value={userId}
            onChange={e => setUserId(e.target.value)}
            aria-invalid={!!fieldMessage('user_id')}
          >
            <option value="">{loadingUsers ? 'Loading…' : 'Choose a person…'}</option>
            {(users ?? []).map(u => (
              <option key={u.id} value={u.id}>
                {u.full_name === u.email ? u.email : `${u.full_name} · ${u.email}`}
                {u.grants.length === 0 ? ' — no roles yet' : ''}
              </option>
            ))}
          </select>
          {fieldMessage('user_id') && <FieldError id="gr-user-err">{fieldMessage('user_id')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="gr-site">Site</label>
          <select
            id="gr-site"
            className="inp"
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
            aria-invalid={!!fieldMessage('site_id')}
          >
            <option value="">{loadingSites ? 'Loading…' : 'Choose a site…'}</option>
            {(sites ?? []).map(s => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
                {s.status !== 'ACTIVE' ? ' (inactive)' : ''}
              </option>
            ))}
          </select>
          {fieldMessage('site_id') && <FieldError id="gr-site-err">{fieldMessage('site_id')}</FieldError>}
        </div>

        <div className="field">
          <label htmlFor="gr-role">Role</label>
          <select
            id="gr-role"
            className="inp"
            value={role}
            onChange={e => setRole(e.target.value as RoleCode | '')}
            aria-invalid={!!fieldMessage('role')}
          >
            <option value="">Choose a role…</option>
            {ENUMS.role_code.map(r => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]} ({r})
              </option>
            ))}
          </select>
          {fieldMessage('role') && <FieldError id="gr-role-err">{fieldMessage('role')}</FieldError>}
        </div>
      </div>

      {role && GROUP_WIDE.includes(role) && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <span>
            <b>{ROLE_LABELS[role]} is group-wide.</b> It is recorded against the site you pick, but it carries across
            every site — including ones added later.
          </span>
        </div>
      )}

      {alreadyHeld && (
        <div className="banner info" style={{ marginTop: 12 }}>
          <span>{user?.full_name} already holds this role at that site. Granting it again changes nothing.</span>
        </div>
      )}

      {user && user.grants.length > 0 && (
        <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
          Currently holds:{' '}
          {user.grants.map(g => `${ROLE_LABELS[g.role]} at ${g.site_code}`).join(', ')}.
        </p>
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
          disabled={!ready || alreadyHeld || mutation.busy}
          onClick={() => mutation.run({ user_id: Number(userId), site_id: Number(siteId), role })}
        >
          {mutation.busy ? 'Granting…' : 'Grant role'}
        </button>
      </div>
    </Card>
  );
}
