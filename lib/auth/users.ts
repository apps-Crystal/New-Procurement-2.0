/**
 * app_users — the mirror of Crystal Core identities.
 *
 * The schema is explicit: "Users come from Crystal Core SSO; app_users mirrors
 * them for FKs." This table is NOT a local login system. It exists so every
 * business record can carry a stable bigint FK for who did what, and so names
 * and emails can be shown without calling Core on every render.
 *
 * Roles are NOT stored here — they live in user_site_roles and are granted by
 * an administrator per site.
 */
import { sql, withDbRetry } from '@/lib/db';
import { invalidatePrincipal } from '@/lib/auth/permissions';

export interface CoreIdentity {
  userId: string; // Crystal Core subject id
  email: string;
  name: string;
}

/**
 * Upsert the Core identity and return the application user id.
 *
 * Matches on core_user_id first. Where a row already exists with the same email
 * but a different core_user_id — a Core account rebuilt, or a row created by
 * `bootstrap:admin` before the person ever signed in — the row is re-pointed
 * rather than duplicated, so their history is preserved. `app_users.email` is
 * UNIQUE, so a duplicate would be rejected anyway.
 *
 * Never changes `status`: deactivating a user is an administrator's decision,
 * not a side effect of them signing in.
 *
 * Runs in one transaction, so two simultaneous sign-ins cannot both insert.
 */
export async function syncUserFromCore(identity: CoreIdentity): Promise<number> {
  const coreId = identity.userId.trim();
  const email = identity.email.trim().toLowerCase();
  const fullName = identity.name.trim() || email;

  const id = await withDbRetry(
    () =>
      sql.begin(async tx => {
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM app_users WHERE core_user_id = ${coreId} FOR UPDATE`;

        if (existing) {
          await tx`
            UPDATE app_users
               SET email = ${email}, full_name = ${fullName}, synced_at = now()
             WHERE id = ${existing.id}`;
          return Number(existing.id);
        }

        const [byEmail] = await tx<{ id: string }[]>`
          SELECT id FROM app_users WHERE email = ${email} FOR UPDATE`;

        if (byEmail) {
          await tx`
            UPDATE app_users
               SET core_user_id = ${coreId}, full_name = ${fullName}, synced_at = now()
             WHERE id = ${byEmail.id}`;
          return Number(byEmail.id);
        }

        const [created] = await tx<{ id: string }[]>`
          INSERT INTO app_users (core_user_id, email, full_name)
          VALUES (${coreId}, ${email}, ${fullName})
          RETURNING id`;
        return Number(created.id);
      }),
    'users',
  );

  invalidatePrincipal(coreId);
  return id;
}
