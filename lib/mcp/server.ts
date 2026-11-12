import { z } from 'zod';

import { defineAccountTool, registerAccountTool, type ToolTarget } from '@/lib/mcp/defineTool';
import { OFFICE_ROLES, isOfficeRole } from '@/lib/mcp/roles';
import { registerArchiveTools } from '@/lib/mcp/tools/archive';
import { registerCustomerTools } from '@/lib/mcp/tools/customers';
import { registerCustomerWriteTools } from '@/lib/mcp/tools/customersWrites';
import { registerImportTools } from '@/lib/mcp/tools/imports';
import { registerInventoryTools } from '@/lib/mcp/tools/inventory';
import { registerInventoryWriteTools } from '@/lib/mcp/tools/inventoryWrites';
import { registerInvoiceTools } from '@/lib/mcp/tools/invoices';
import { registerInvoiceWriteTools } from '@/lib/mcp/tools/invoicesWrites';
import { registerJobTools } from '@/lib/mcp/tools/jobs';
import { registerJobWriteTools } from '@/lib/mcp/tools/jobsWrites';
import { registerOverviewTools } from '@/lib/mcp/tools/overview';
import { registerPartTools } from '@/lib/mcp/tools/parts';
import { registerPartWriteTools } from '@/lib/mcp/tools/partsWrites';
import { registerPurchasingTools } from '@/lib/mcp/tools/purchasing';
import { registerPurchasingWriteTools } from '@/lib/mcp/tools/purchasingWrites';
import { registerQueryTools } from '@/lib/mcp/tools/query';
import { registerQuoteTools } from '@/lib/mcp/tools/quotes';
import { registerQuoteWriteTools } from '@/lib/mcp/tools/quotesWrites';
import { registerShippingTools } from '@/lib/mcp/tools/shipping';
import { registerShippingWriteTools } from '@/lib/mcp/tools/shippingWrites';
import { registerVendorTools } from '@/lib/mcp/tools/vendors';
import { registerVendorWriteTools } from '@/lib/mcp/tools/vendorsWrites';
import { registerWorkCenterTools } from '@/lib/mcp/tools/workCenters';
import { registerWorkCenterWriteTools } from '@/lib/mcp/tools/workCentersWrites';
import { getUserCompanies } from '@/utils/companyAccess';

export { OFFICE_ROLES, isOfficeRole, type OfficeRole } from '@/lib/mcp/roles';

/**
 * The Jigged MCP server's tools.
 *
 * Every tool is declared with `defineCompanyTool` / `defineAccountTool` and registered through
 * the wrapper in lib/mcp/defineTool.ts, which checks the caller, the company and the rate limit,
 * and logs every call. Company tools live in lib/mcp/tools/, one file per area, each with its own
 * register function. The catalogue arrives milestone by milestone; the plan is
 * `docs/modules/ai-assistants.md` once written.
 */

const DemoSchema = z.object({
  company_id: z.string(),
  url: z.string().nullable(),
});

const CompanySchema = z.object({
  company_id: z.string(),
  name: z.string(),
  role: z.enum(OFFICE_ROLES),
  url: z.string().nullable(),
  demo: DemoSchema.nullable(),
});

export const listMyCompanies = defineAccountTool({
  name: 'list_my_companies',
  title: 'List my companies',
  description:
    'Lists the Jigged companies you can work in from this assistant, with your role in each ' +
    '(admin or user). Every other Jigged tool takes one of these company ids. A company that ' +
    'has a demo lists it under `demo`: a separate practice copy of that company filled with ' +
    'sample data, whose company_id every tool accepts too. Changes in a demo never reach the ' +
    'real company; setting one up or resetting it is done on the Jigged website. Companies ' +
    'where you are an operator are not listed: operator logins cannot use Jigged from an ' +
    'assistant.',
  output: { companies: z.array(CompanySchema) },
  access: 'read',
  run: async ({ caller, link }) => {
    const rows = await getUserCompanies(caller.userId);
    const companies = rows.flatMap((row) => {
      if (!isOfficeRole(row.role)) return [];
      // The demo belongs to the company: offered exactly when the company is, to the same
      // people. The tool wrapper resolves a demo through its company (lib/mcp/company.ts), so
      // the company's role is the one that decides.
      const demoId = row.companies?.demo_company_id ?? null;
      return [
        {
          company_id: row.company_id,
          name: row.companies?.name ?? 'Unnamed company',
          role: row.role,
          url: link(`/dashboard/${row.company_id}`),
          demo: demoId ? { company_id: demoId, url: link(`/dashboard/${demoId}`) } : null,
        },
      ];
    });
    if (companies.length === 0) {
      return {
        ok: true,
        data: { companies },
        text:
          "You don't have an office role (admin or user) in any Jigged company, so this " +
          'assistant has nothing it can do for you yet. A company admin can change your role ' +
          'under Team in Jigged.',
      };
    }
    return { ok: true, data: { companies } };
  },
});

export function registerJiggedTools(server: ToolTarget): void {
  registerAccountTool(server, listMyCompanies);
  registerOverviewTools(server);
  registerJobTools(server);
  registerQuoteTools(server);
  registerCustomerTools(server);
  registerVendorTools(server);
  registerPartTools(server);
  registerWorkCenterTools(server);
  registerInventoryTools(server);
  registerShippingTools(server);
  registerInvoiceTools(server);
  registerPurchasingTools(server);
  registerQueryTools(server);

  // Changes, one area at a time; the consequential ones (convert, cancel, void, archive, the
  // QuickBooks pushes, imports, closing or voiding on a purchase order to a vendor) are marked
  // destructive so the assistant asks before running them.
  registerCustomerWriteTools(server);
  registerVendorWriteTools(server);
  registerPartWriteTools(server);
  registerWorkCenterWriteTools(server);
  registerQuoteWriteTools(server);
  registerJobWriteTools(server);
  registerInventoryWriteTools(server);
  registerShippingWriteTools(server);
  registerInvoiceWriteTools(server);
  registerPurchasingWriteTools(server);
  registerImportTools(server);
  registerArchiveTools(server);
}
