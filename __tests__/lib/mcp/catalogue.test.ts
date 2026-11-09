import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { registerJiggedTools } from '@/lib/mcp/server';

/**
 * The whole catalogue, as an assistant sees it at tools/list. These are the rules both
 * directories review against and the guardrails that no single tool's test can see:
 *
 *   - a snake_case name of 64 characters or fewer, unique, and a title;
 *   - every hint set explicitly (ChatGPT requires readOnlyHint, destructiveHint and
 *     openWorldHint to be present; Claude prompts on destructive ones);
 *   - a description that says what the tool does rather than steering the assistant;
 *   - no output field that names a person against shop-floor work (the surveillance guardrail,
 *     docs/modules/operator-view.md).
 */

interface Registered {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: z.ZodType;
    outputSchema?: z.ZodType;
    annotations?: Record<string, unknown>;
  };
}

function catalogue(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    registerTool: (name: string, config: Registered['config']) => {
      tools.push({ name, config });
    },
  };
  registerJiggedTools(server as unknown as Parameters<typeof registerJiggedTools>[0]);
  return tools;
}

/** Every property name anywhere in a JSON Schema. */
function propertyNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, into);
  } else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const name of Object.keys(value)) into.add(name);
      }
      propertyNames(value, into);
    }
  }
  return into;
}

/** Fields that would say who did the work. `created_by` and the like on office records too. */
const PERSON_FIELDS = [
  /^completed_by/,
  /^sent_by/,
  /^received_by/,
  /^created_by/,
  /^updated_by/,
  /^performed_by/,
  /^issued_by/,
  /^moved_by/,
  /^counted_by/,
  /^author/,
  /^operator/,
  /^user_id$/,
  /^user_name$/,
  /_by_name$/,
];

/** Phrases that steer the assistant rather than describe the tool. */
const STEERING = [/\byou must\b/i, /\balways\b/i, /\bnever call\b/i, /\bbefore (calling|using) any\b/i, /\bignore\b/i];

describe('the MCP tool catalogue', () => {
  const tools = catalogue();

  it('registers the read tools', () => {
    expect(tools.length).toBeGreaterThan(1);
  });

  it.each(tools.map((t) => [t.name, t] as const))('%s is named, titled and hinted', (_name, tool) => {
    expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(tool.name.length).toBeLessThanOrEqual(64);
    expect(tool.config.title?.trim()).toBeTruthy();
    expect(tool.config.description?.trim()).toBeTruthy();
    const hints = tool.config.annotations ?? {};
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      expect(typeof hints[hint], `${tool.name}.${hint}`).toBe('boolean');
    }
    if (hints.readOnlyHint) expect(hints.destructiveHint).toBe(false);
    for (const phrase of STEERING) expect(tool.config.description).not.toMatch(phrase);
  });

  it('has no duplicate names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(tools.map((t) => [t.name, t] as const))('%s returns no person against the work', (_name, tool) => {
    expect(tool.config.outputSchema).toBeDefined();
    const names = propertyNames(z.toJSONSchema(tool.config.outputSchema as z.ZodType, { io: 'output' }));
    const offending = [...names].filter((n) => PERSON_FIELDS.some((p) => p.test(n)));
    expect(offending).toEqual([]);
  });

  it('every company tool takes company_id', () => {
    for (const tool of tools.filter((t) => t.name !== 'list_my_companies')) {
      const input = z.toJSONSchema(tool.config.inputSchema as z.ZodType);
      expect(propertyNames(input).has('company_id'), tool.name).toBe(true);
    }
  });
});
