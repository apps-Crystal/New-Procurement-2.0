/**
 * GET /api/invoices/awaiting — orders that have received goods.
 *
 * The picker for booking an invoice. It carries each site's state code beside
 * the vendor's, because that comparison is what decides the GST mode and is
 * worth showing before the figures are typed rather than after they are
 * refused.
 */
import { handler } from '@/lib/api';
import { awaitingInvoice } from '@/lib/services/invoices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal }) => awaitingInvoice(principal));
