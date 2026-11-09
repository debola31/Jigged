import { clientKindOf } from '@/lib/mcp/clientKind';
import type { CallOutcome } from '@/lib/mcp/audit';
import { getPostHogClient } from '@/lib/posthog-server';

/**
 * One PostHog event per MCP tool call: which tool, from which assistant, read or write, and how
 * it ended. The shape of the call only, never its arguments or results (docs/telemetry.md), so
 * no company data leaves in it. `mcp_tool_calls` holds the per-call audit; this is the product
 * view of the same thing, next to the app's own events.
 *
 * Never throws and never delays a reply by more than its flush: an assistant's answer must not
 * fail because analytics did. Off wherever the PostHog token is unset (local, previews, tests).
 */
export async function reportToolCall(call: {
  userId: string;
  tool: string;
  clientName: string | null;
  isWrite: boolean;
  outcome: CallOutcome;
}): Promise<void> {
  try {
    const client = getPostHogClient();
    if (!client) return;
    // Named `posthog.capture(...)` so scripts/analyticsEventsCheck.ts can match this call to its
    // row in the event registry, as it does for every browser capture.
    const posthog = {
      capture: (event: string, properties: Record<string, string | boolean>) =>
        client.capture({ distinctId: call.userId, event, properties }),
    };
    posthog.capture('mcp tool called', {
      tool: call.tool,
      client_kind: clientKindOf(call.clientName),
      is_write: call.isWrite,
      outcome: call.outcome,
    });
    // Serverless: the function may freeze as soon as the reply is sent, taking the queue with it.
    await client.flush();
  } catch {
    // Analytics is best-effort by design; the audit row is the record that must not be lost.
  }
}
