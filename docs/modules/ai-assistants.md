# AI assistants (the MCP server)

**As-built, verified 2026-11-10.** A shop's own Claude or ChatGPT works in Jigged through the MCP
server at `https://jigged.app/mcp`, acting as the signed-in office user: it reads and changes the
same records, under the same rules, as that person's browser. The tool catalogue is
[`lib/mcp/server.ts`](../../lib/mcp/server.ts), one file per area under
[`lib/mcp/tools/`](../../lib/mcp/tools). The public help page is `/ai-assistants`
(`app/(marketing)/ai-assistants/page.tsx`), which is also where a browser opening `/mcp` lands.

**The design in one line: the assistant is the user's own AI, never Jigged's.** No tool calls
Jigged's Anthropic or Ollama paths, so assistant use spends none of Jigged's AI credits, and
CLAUDE.md's rule that AI calls need an explicit user action holds without exception.

## How a call is authorised

Each step runs on every call; a refusal is a sentence back to the assistant, never a protocol
error.

| Step | Where | Why it is there |
|---|---|---|
| OAuth 2.1 sign-in and consent | Supabase Auth's OAuth server (DCR, PKCE); consent page [`OAuthConsent.tsx`](../../components/auth/OAuthConsent.tsx) | Only redirects to known assistants are approved ([`lib/mcp/assistants.ts`](../../lib/mcp/assistants.ts)), so a look-alike client can't harvest a token through our page |
| Token check | [`lib/mcp/auth.ts`](../../lib/mcp/auth.ts) | Requires the `client_id` claim: a browser session token is not an assistant token |
| Office role, and which company | [`lib/mcp/company.ts`](../../lib/mcp/company.ts) | RLS is membership-only, so the server draws the office/operator line itself. A demo resolves through its real company, so a stale demo mirror never decides |
| Rate limit | [`lib/mcp/audit.ts`](../../lib/mcp/audit.ts) | Counts `mcp_tool_calls` rows; an in-memory limiter doesn't hold on serverless |
| The call itself | `runAsCaller` in [`lib/mcp/requestClient.ts`](../../lib/mcp/requestClient.ts) | `getSupabase()` returns the caller's client, so the unchanged access layer runs under RLS and the billing write-gate |
| Record | `mcp_tool_calls` (migration `20261109155810`), PostHog `mcp tool called` ([`lib/mcp/telemetry.ts`](../../lib/mcp/telemetry.ts)) | The audit is the call's shape only: tool, outcome, timing, client name; never arguments or results |

**An assistant token works only through `/mcp`.** Supabase does not bind a token to a resource, so
a token sent anywhere else would otherwise reach PostgREST with the user's full rights. A
malicious MCP server can name Jigged's Supabase as its authorization server, get the user to
click Allow, and keep the token. Every surface refuses an assistant token that doesn't carry the
server's gateway key (`x-jigged-mcp`, `MCP_GATEWAY_KEY`):
- PostgREST, through `db_pre_request` (`public.mcp_token_binding`, migration `20261109163801`);
- FastAPI, through `refuse_unbound_assistant` ([`company_auth.py`](../../api/routes/company_auth.py));
- Storage, through a restrictive policy.

Rotating the key means registering a new fingerprint with `register_mcp_gateway_key` and deleting
the old row by hand.

## Rules every tool follows

| Rule | Enforced by |
|---|---|
| snake_case name ≤ 64 characters, a title, every hint explicit, a description that says what the tool does and doesn't steer the assistant, and no output field that names a person | [`__tests__/lib/mcp/catalogue.test.ts`](../../__tests__/lib/mcp/catalogue.test.ts), over every registered tool |
| A write calls the same `utils/*Access.ts` function, with the same arguments and refusals, as the screen that does it; the same people may do it | Review. Each tool's file names the component it mirrors |
| Hard-to-undo steps are `destructive` (convert, cancel, void, archive, import, QuickBooks push), so both assistants ask first | The catalogue test; review |
| Lists leave archived records out; by-id reads find them and say `archived` | The access functions; per-tool tests |
| Dashboard money totals and stock value go to admins only; quote, job and invoice prices go to every office user, as in the app | Per-tool tests under [`__tests__/lib/mcp/tools/`](../../__tests__/lib/mcp/tools) |
| Nothing names who did shop-floor work; the data query refuses person columns | The catalogue test; [`insights_routes.py`](../../api/routes/insights_routes.py) and [`test_insights_query_route.py`](../../api/tests/unit/test_insights_query_route.py) |
| An error is a sentence: the access layer's rules come back as refusals, its own failures and backend outages are reported, a programming error's text never shows | `failure()` in [`defineTool.ts`](../../lib/mcp/defineTool.ts); [`defineTool.test.ts`](../../__tests__/lib/mcp/defineTool.test.ts) |
| A write whose reply doesn't fit its schema says it was saved, so the assistant doesn't repeat it | `settle()` in `defineTool.ts`. Found end to end: `create_job` saved a job and then failed validation |
| A FastAPI route that writes with the service role asks `company_can_write` first | `assert_company_can_write`; the QuickBooks push gained it here (it had none, in the browser too) |

**Backend calls go through [`lib/mcp/backend.ts`](../../lib/mcp/backend.ts), never the browser's
helpers.** `utils/quickbooksAccess.ts` and friends read a browser session and call a relative
`/api/...`; on the server there is neither. The MCP tools that need FastAPI are the QuickBooks
push, `preview_import`/`import_records` (the import routes' `dry_run`,
[data-import.md](data-import.md#dry-run-for-ai-assistants-2026-11-09)), and
`get_data_schema`/`query_shop_data` (`/api/insights/{id}/schema` and `/query`: one validated SELECT
as `jigged_ai_readonly`, no LLM call, no `ai_jobs` row).

**`getCurrentMember` never shares a lookup on the server.** It shares one in-flight lookup per
company because a browser holds one person. The MCP route answers several people of one company
at once, so a shared lookup would credit one person's note or step to another
([`operatorAccess.ts`](../../utils/operatorAccess.ts)).

## Connecting and disconnecting

- **Connecting:** the dashboard's **Connect your assistant** opens a dialog
  ([`ConnectAssistantDialog.tsx`](../../components/aiAssistants/ConnectAssistantDialog.tsx)) with a
  Claude card (a prefilled install link) and a ChatGPT card (copy the URL, open
  `chatgpt.com/plugins`). Both cards and the public page describe the assistants' own screens, so
  they date: recheck them when either assistant changes.
- **Disconnecting:** a person's connected assistants are under **AI assistants** in the account
  menu (`listGrants`/`revokeGrant`). Revoking deletes the sessions. An access token already issued
  keeps passing `/mcp`'s local check until it expires (an hour at most), and its next refresh fails.

## Decisions (the user's)

| Decision | Date |
|---|---|
| Office roles only; operators are refused at consent and on every call | 2026-11-08 |
| No per-company switch: any office user may connect, and an assistant may do what that person may | 2026-11-09 (#901) |
| A demo is listed under its company and every tool accepts its id; setting up or resetting a demo stays website-only | 2026-11-09 |
| Jigged's in-app AI stays for now; whether to retire it is decided from usage | 2026-11-08 |
| Connecting opens in place: a dialog, not a page | 2026-11-09 / 2026-11-10 (#906, #912) |

**Withdrawn:**
- **`ai_assistants` / `ai_assistant_writes` opt-out flags with a Settings card.** Wrong because the
  owner wanted assistants available to every office user with nothing to set.
- **A generic `fetch` tool for any record.** Replaced by typed `get_job`, `get_quote` and the rest,
  whose output schemas tell the assistant what comes back.
- **A one-line connect menu.** It left ChatGPT's longer setup unexplained.

## Known gaps

- **`jigged_ai_readonly` can still read person columns** (`completed_by`, `operator_id`, …). The
  query route refuses statements and results that name them, but `row_to_json(row)` gets past
  that. Revoking those columns from the role would close it, for Jigged's own Insights as well.
- **`query_shop_data` needs `AI_READONLY_DATABASE_URL` on the backend.** Without it the tool
  answers that queries aren't available. Set in production, verified through `/mcp` on 2026-11-10.
- **The privacy policy has no section on connected assistants.** Deferred by the owner on
  2026-11-10. The help page states what is kept, and a policy change means publishing privacy v2
  ([legal-acceptance.md](legal-acceptance.md)).
- **No ChatGPT `search`/`fetch` pair without a `company_id`**, so ChatGPT's deep research and
  company-knowledge features don't use Jigged.
- **No links to attachments.** Storage refuses assistant tokens, so such a tool needs a
  service-role signing step.
- **"Today" and "overdue" use the server's clock (UTC)**, so near midnight they can differ from the
  shop's own day.
- **Real-assistant tests need production.** Previews are behind Vercel protection, and preview
  branches ignore the OAuth server's config.

## Testing

- **Vitest:**
  - [`__tests__/lib/mcp/`](../../__tests__/lib/mcp): the wrapper, the catalogue, the route, and one
    file per tool area;
  - [`__tests__/components/aiAssistants/`](../../__tests__/components/aiAssistants): the connect
    dialog and the connected list.
- **Pytest:**
  - [`test_import_dry_run.py`](../../api/tests/unit/test_import_dry_run.py) and
    [`test_insights_query_route.py`](../../api/tests/unit/test_insights_query_route.py) (unit);
  - [`test_mcp_token_binding.py`](../../api/tests/integration/test_mcp_token_binding.py) and
    [`test_insights_query.py`](../../api/tests/integration/test_insights_query.py) (integration;
    the binding test runs the real OAuth flow).
- **End to end before release:** a production build against the local stack and local FastAPI,
  with a scripted OAuth flow (DCR, PKCE, consent through the API, code exchange), calling every
  tool once as an admin and once as a user.
- **Directory submissions:** [runbooks/mcp-directory-submission.md](../runbooks/mcp-directory-submission.md).
