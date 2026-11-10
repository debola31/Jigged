import { z } from 'zod';

import { ToolCatalog, type CatalogTool } from '@/lib/mcp/defineTool';
import { registerJiggedTools } from '@/lib/mcp/server';

/**
 * The tools Jigged chat can use: every company tool the MCP server offers, from the same
 * registration code (`registerJiggedTools`), minus the two the chat already has its own way of
 * doing. One list, so a tool added for Claude or ChatGPT reaches the chat in the same change.
 *
 * The backend (api/services/chat_actions.py) fetches the manifest per question and calls tools
 * through app/chat-tools/route.ts; it never sees this module.
 */

/**
 * The chat answers questions with its own read-only SQL sandbox (execute_sql) and carries the
 * schema in its prompt, so the MCP equivalents would only be a second, slower way to the same
 * thing -- and a second way to spend the person's rate limit.
 */
export const CHAT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['query_shop_data', 'get_data_schema']);

let cached: CatalogTool[] | null = null;

export function chatTools(): CatalogTool[] {
  if (!cached) {
    const catalog = new ToolCatalog();
    registerJiggedTools(catalog);
    cached = catalog.tools.filter((tool) => !CHAT_EXCLUDED_TOOLS.has(tool.name));
  }
  return cached;
}

export function chatTool(name: string): CatalogTool | undefined {
  return chatTools().find((tool) => tool.name === name);
}

export interface ChatToolManifestEntry {
  name: string;
  title: string;
  description: string;
  access: 'read' | 'write';
  destructive: boolean;
  /** JSON Schema of the tool's own input; no company_id. */
  input_schema: Record<string, unknown>;
}

/**
 * What the backend hands the model. JSON Schema of the INPUT side (`io: 'input'`): a field with
 * a default is optional to the caller even though the parsed value always has it.
 *
 * Stable order (registration order) and stable content, because the list is part of the
 * prompt's cached prefix: the same deployment gives byte-identical definitions to every question.
 */
export function chatToolManifest(): ChatToolManifestEntry[] {
  return chatTools().map((tool) => {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      access: tool.access,
      destructive: tool.destructive,
      input_schema: schema,
    };
  });
}
