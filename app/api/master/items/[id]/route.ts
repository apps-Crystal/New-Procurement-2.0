/**
 * GET   /api/master/items/[id]
 * PATCH /api/master/items/[id]   (MASTER.ITEM_MANAGE)
 */
import { handlerWithParams, numericId, readJson } from '@/lib/api';
import { updateItem } from '@/lib/services/masters';
import { sql } from '@/lib/db';
import { notFound } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => {
  const [item] = await sql`SELECT * FROM items WHERE id = ${numericId(params.id)}`;
  if (!item) throw notFound('That item no longer exists.');
  return item;
});

export const PATCH = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return updateItem({ principal, ip }, numericId(params.id), body as never);
});
