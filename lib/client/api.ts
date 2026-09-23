'use client';

/**
 * Client-side API access.
 *
 * Every route answers the same envelope — { ok: true, data } or
 * { ok: false, error: { message, kind, field? } } — so error handling is done
 * once here rather than at every call site. `field` is what lets a screen put
 * the message against the input that caused it instead of in a banner.
 */

export interface ApiError {
  message: string;
  kind: 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';
  field?: string;
}

export class ApiFailure extends Error {
  readonly kind: ApiError['kind'];
  readonly field?: string;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiFailure';
    this.kind = error.kind;
    this.field = error.field;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // A dropped connection is not the same as a refusal, and the message
    // should not suggest the user did something wrong.
    throw new ApiFailure({
      message: 'Could not reach the server. Check your connection and try again.',
      kind: 'INTERNAL',
    });
  }

  let body: { ok: boolean; data?: T; error?: ApiError };
  try {
    body = await res.json();
  } catch {
    throw new ApiFailure({ message: 'The server returned something unexpected.', kind: 'INTERNAL' });
  }

  if (!body.ok || !res.ok) {
    throw new ApiFailure(
      body.error ?? { message: 'Something went wrong.', kind: 'INTERNAL' },
    );
  }

  return body.data as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, data?: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  patch: <T>(url: string, data: unknown) => request<T>(url, { method: 'PATCH', body: JSON.stringify(data) }),
  put: <T>(url: string, data: unknown) => request<T>(url, { method: 'PUT', body: JSON.stringify(data) }),
  del: <T>(url: string, data?: unknown) => request<T>(url, { method: 'DELETE', body: JSON.stringify(data ?? {}) }),
};

/** Query string from a record, skipping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
