import { z } from 'zod';
import { uploadedPartSchema } from '@/lib/chatUploads';
import { defineCompanyTool, registerCompanyTool, type ToolTarget } from '@/lib/mcp/defineTool';
import { canonicalUnit } from '@/lib/mcp/tools/imports';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import type { DrawingRow } from '@/types/drawingImport';
import { readChatUpload } from '@/utils/chatUploadsAccess';
import { getCustomerWithRelations } from '@/utils/customerAccess';
import { createPartsFromRows } from '@/utils/drawingImportCreate';
import { resolveIdentities } from '@/utils/drawingImportIdentity';
import { copyChatFileToPart } from '@/utils/partAttachmentsAccess';

const uploadInput = {
  manifest_path: z.string().max(500).describe('The manifest_path of a package attached in Jigged chat.'),
};

export const readUploadedDrawings = defineCompanyTool({
  name: 'read_uploaded_drawings', title: 'Read uploaded drawings', access: 'read',
  description: 'Reads a drawing package attached in Jigged chat: one group per part, its extracted ' +
    'part number, description, drawing number and revision, and its PDF, DXF and STEP source files. ' +
    'read_source says which drawing supplied the text; none means no readable text was found. Makes no AI call.',
  input: uploadInput,
  output: { parts: z.array(uploadedPartSchema) },
  run: async (args, env) => ({ ok: true, data: await readChatUpload(env.company.id, args.manifest_path) }),
});

export const setupUploadedParts = defineCompanyTool({
  name: 'setup_parts_from_upload', title: 'Set up parts from uploaded drawings', access: 'write',
  idempotent: false,
  description: 'Sets up parts from a package attached in Jigged chat, using the Add parts from drawings ' +
    'identity checks and creation path. Copies each PDF, DXF and STEP file onto its part. A customer ' +
    'reference already known attaches to that part without overwriting its fields; a taken name gets ' +
    'a new name instead of merging unrelated parts. No routing, materials, stock or prices are invented. ' +
    'draft_quote returns a link to New Quote with these parts prefilled for review, including parts still ' +
    'needing prices. The quote is saved only when completed in the form or by create_quote. Each row reports failures.',
  input: {
    ...uploadInput,
    customer_id: z.guid().optional().describe('The customer these drawings belong to, when known.'),
    unit: z.string().default('each').describe('The primary unit for new parts. Defaults to each.'),
    source: z.enum(['made', 'bought']).default('made'),
    stems: z.array(z.string()).min(1).max(50).optional().describe('Only these exact group stems. All groups when omitted.'),
    draft_quote: z.boolean().default(false).describe('Return an unsaved quote form prefilled with the parts, for review.'),
  },
  output: {
    parts: z.array(z.object({
      part_id: z.string().nullable(), part_name: z.string(),
      action: z.enum(['created', 'updated', 'skipped', 'failed']),
      files_attached: z.number(), file_errors: z.array(z.string()), error: z.string().nullable(),
    })),
    quote_draft_url: urlOutput,
    quote_saved: z.literal(false),
  },
  run: async (args, env) => {
    const unit = canonicalUnit(args.unit);
    if (!unit) return { ok: false, message: 'Give a recognised unit of measure for these parts.' };
    if (args.customer_id) {
      const customer = await getCustomerWithRelations(args.customer_id);
      if (!customer || customer.company_id !== env.company.id || customer.deleted_at) {
        return { ok: false, message: 'That customer is not available in this company.' };
      }
    }
    const manifest = await readChatUpload(env.company.id, args.manifest_path);
    if (args.stems?.some((stem) => !manifest.parts.some((part) => part.stem === stem))) {
      return { ok: false, message: 'One of those groups is not in this upload. Read the uploaded drawings first.' };
    }
    const selected = manifest.parts.filter((part) => !args.stems || args.stems.includes(part.stem));
    const identities = await resolveIdentities(env.company.id, args.customer_id ?? null,
      selected.map((part) => ({ stem: part.stem, partName: part.part_name, customerPartNumber: part.customer_part_number })));
    const rows: DrawingRow[] = selected.map((part) => ({
      stem: part.stem, group: { stem: part.stem, files: [] }, readSource: part.read_source,
      fields: {}, cutList: null, excluded: false,
      identity: identities.get(part.stem) ?? { kind: 'unknown', reason: 'No identity check result.' },
      edits: { ...part, source: args.source, primary_unit: unit },
    }));
    const results = await createPartsFromRows(rows, {
      companyId: env.company.id, customerId: args.customer_id ?? null, defaultUnit: unit,
      attachUploadedFiles: async (partId, row) => {
        const files = selected.find((part) => part.stem === row.stem)!.files;
        const errors: string[] = [];
        // Row concurrency is already bounded by createPartsFromRows.
        for (const file of files) {
          try { await copyChatFileToPart(env.company.id, partId, file); }
          catch { errors.push(`${file.name}: could not attach this file. The source remains in the chat upload.`); }
        }
        return { attached: files.length - errors.length, errors };
      },
    });
    const ids = results.filter((row) => row.partId && row.action !== 'failed').map((row) => row.partId!);
    const query = new URLSearchParams({ parts: ids.join(',') });
    if (args.customer_id) query.set('customer', args.customer_id);
    return { ok: true, data: {
      parts: results.map((row) => ({
        part_id: row.partId, part_name: row.partName, action: row.action,
        files_attached: row.filesAttached, file_errors: row.fileErrors, error: row.error ?? null,
      })),
      quote_draft_url: args.draft_quote && ids.length ? companyLink(env, `/quotes/new?${query}`) : null,
      quote_saved: false as const,
    } };
  },
});

export function registerChatUploadTools(server: ToolTarget): void {
  registerCompanyTool(server, readUploadedDrawings);
  registerCompanyTool(server, setupUploadedParts);
}
