/**
 * GET  /api/master/budget-codes
 * POST /api/master/budget-codes   (MASTER.BUDGET_MANAGE)
 */
import { handler, readJson, requireString, optionalId, optionalString } from '@/lib/api';
import { createBudgetCode, listBudgetCodes } from '@/lib/services/masters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => listBudgetCodes());

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return createBudgetCode(
    { principal, ip },
    {
      code: requireString(body.code, 'code'),
      financialYear: requireString(body.financial_year, 'financial_year'),
      siteId: optionalId(body.site_id, 'site_id'),
      category: optionalString(body.category, 'category'),
      description: optionalString(body.description, 'description', 200),
    },
  );
});
