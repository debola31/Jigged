#!/usr/bin/env node
/**
 * Anthropic Messages API mock for E2E.
 *
 * Why a mock at all: the only AI surface E2E touches is the CSV-import
 * column-mapping flow (`api/services/ai/claude_provider.py` → CSV mapping
 * prompt → mapped columns). Real Anthropic calls cost money per CI run
 * and add nondeterminism; lower-level integration tests in
 * `api/tests/integration/` already cover the real-provider path (gated
 * by `ANTHROPIC_API_KEY` being set to a real value).
 *
 * Why a tiny Node HTTP server (not vitest-msw or a mock library): this
 * runs OUTSIDE the test process — it has to respond to HTTP from the
 * FastAPI backend running in a separate process. A standalone server is
 * the only shape that works for the three-service orchestration.
 *
 * The Anthropic Python SDK's `anthropic.Anthropic()` client respects the
 * `ANTHROPIC_BASE_URL` env var and routes all `client.messages.create()`
 * calls through it. So setting `ANTHROPIC_BASE_URL=http://localhost:${PORT}`
 * is all the wiring the backend needs.
 *
 * What we return: a canned column-mapping JSON shaped like
 * `MAPPING_PROMPT_TEMPLATE` (see claude_provider.py:42-48) wrapped in an
 * Anthropic Messages API response. The fixture CSV
 * (`e2e/fixtures/test-parts.csv`) has columns: Part Number, Description,
 * Source, Stocked. The mapping below assumes those headers; if the
 * fixture changes, update `MOCK_MAPPING` to match.
 */

import http from 'node:http';

const PORT = parseInt(process.env.ANTHROPIC_MOCK_PORT || '9876', 10);

// CSV → DB field mapping for the test-parts.csv fixture (Part Name +
// Description). Confidence ≥ 0.8 keeps the UI on the auto-advance path;
// review-prompts would force the spec to handle extra screens. If the
// fixture grows new columns, extend this list to match — otherwise the
// importer will mark them needs-review.
const MOCK_MAPPING = {
  mappings: [
    {
      csv_column: 'Part Name',
      db_field: 'part_name',
      confidence: 0.99,
      reasoning: 'Direct match for part identifier',
    },
    {
      csv_column: 'Description',
      db_field: 'description',
      confidence: 0.99,
      reasoning: 'Direct match',
    },
  ],
};

function buildResponse() {
  // Anthropic Messages API shape — only the fields the SDK reads back.
  return {
    id: 'msg_mock_e2e',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-mock',
    content: [
      {
        type: 'text',
        text: JSON.stringify(MOCK_MAPPING),
      },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/v1/messages')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(buildResponse()));
    });
    return;
  }

  // Health probe used by start-server-and-test.
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'mock_not_implemented', path: req.url, method: req.method }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[anthropic-mock] listening on http://localhost:${PORT}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
