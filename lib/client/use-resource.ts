'use client';

/**
 * Loading / empty / error state, in one place.
 *
 * Brief §25 requires every screen to have loading, empty, error, validation,
 * success and permission-aware states. The prototype had none of them — it
 * rendered synchronously from a JavaScript object — so these are net-new and
 * worth doing once rather than per screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiFailure } from '@/lib/client/api';

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch, e.g. after a mutation or from a Retry button. */
  reload: () => void;
}

export function useResource<T>(url: string | null, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // A slow response must never overwrite a newer one.
  const latest = useRef(0);

  /**
   * When the url changes, the data in hand belongs to the OLD url. The fetch is
   * started by an effect, and an effect does not run until after this render
   * has committed — so without this there is one frame in which a caller that
   * has already switched (a tab, a filter, a record) is handed the previous
   * url's rows and renders them as if they were its own.
   *
   * On the master-data screen that frame put budget-code rows through the
   * users-and-roles table, where every row keyed to `undefined`, collided, and
   * React dropped one. The other tables hid it only because they key on `id`
   * and stale rows happen to have unique ones — they were still rendering the
   * wrong tab's data for that frame.
   *
   * Adjusting state during render is React's documented answer to exactly this:
   * it re-renders immediately, before any child sees the mismatch. `reload()`
   * goes through `nonce` instead and deliberately does NOT clear, so refreshing
   * after a mutation does not blink.
   */
  const [shownUrl, setShownUrl] = useState(url);
  if (url !== shownUrl) {
    setShownUrl(url);
    setData(null);
    setError(null);
    setLoading(url !== null);
  }

  useEffect(() => {
    if (url === null) {
      setLoading(false);
      return;
    }
    const run = ++latest.current;
    setLoading(true);
    setError(null);

    api
      .get<T>(url)
      .then(result => {
        if (latest.current === run) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (latest.current !== run) return;
        setError(err instanceof Error ? err.message : 'Something went wrong.');
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, ...deps]);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  return { data, loading, error, reload };
}

export interface Mutation<TArgs> {
  run: (args: TArgs) => Promise<void>;
  busy: boolean;
  /** Message for a banner — a refusal that is not about one field. */
  error: string | null;
  /** Message for a specific input, from the server's `field`. */
  fieldError: { field: string; message: string } | null;
  success: string | null;
  reset: () => void;
}

/**
 * A mutating call, with the feedback a form needs.
 *
 * Server-side validation is authoritative (§31), so a refusal is surfaced as it
 * came back — attached to its field where the server named one. Client-side
 * checks exist to save a round trip, never to decide.
 */
export function useMutation<TArgs>(
  fn: (args: TArgs) => Promise<unknown>,
  opts: { onDone?: () => void; successMessage?: string } = {},
): Mutation<TArgs> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = useCallback(() => {
    setError(null);
    setFieldError(null);
    setSuccess(null);
  }, []);

  const run = useCallback(
    async (args: TArgs) => {
      setBusy(true);
      reset();
      try {
        await fn(args);
        setSuccess(opts.successMessage ?? 'Saved.');
        opts.onDone?.();
      } catch (err) {
        if (err instanceof ApiFailure && err.field) {
          setFieldError({ field: err.field, message: err.message });
        } else {
          setError(err instanceof Error ? err.message : 'Something went wrong.');
        }
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn, opts.successMessage],
  );

  return { run, busy, error, fieldError, success, reset };
}

/** The signed-in user, their roles and the permissions they hold. */
export interface Session {
  userId: number;
  email: string;
  fullName: string;
  roles: string[];
  groupWide: boolean;
  sites: { siteId: number; siteCode: string; siteName: string; roles: string[] }[];
  granted: string[];
  /**
   * A development switch is relaxing access (OPEN_ACCESS / OPEN_APPROVALS).
   * Screens use it only to smooth testing — prefilling a field, say — never to
   * decide whether something is allowed. That is still `granted` and the server.
   */
  devOpenAccess: boolean;
}

export function useSession(): Resource<Session> {
  return useResource<Session>('/api/auth/session');
}
