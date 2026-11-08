/**
 * Pins the two Next.js behaviours our Server Action telemetry rests on, so an upgrade that changes
 * either fails the build instead of changing what Sentry sees.
 *
 * 1. **An unrecognized Server Action is answered, not thrown.** Until Next 16.3, a generic
 *    `multipart/form-data` POST with no valid `$ACTION_*` fields threw **E975** and 500'd, and
 *    `onRequestError` filed it unhandled — Sentry JAVASCRIPT-NEXTJS-3A was 12 of them from two
 *    scanner IPs, which `sentry.server.config.ts` used to filter. Next 16.4 (vercel/next.js#98123)
 *    answers 400/409 through `handleUnrecognizedAction`, which only `console.warn`s, so that filter
 *    could no longer fire and was removed. If Next ever throws here again, the scanner 500s return.
 *
 * 2. **The browser still sees deployment skew.** `lib/serverActionSkew.ts` reports a real prospect
 *    blocked by a deploy (`UnrecognizedActionError`, E715) at `error` level. The same Next change
 *    moved the server's answer from 404 to 409; the client keys on the `x-nextjs-action-not-found`
 *    header, not the status, so the report survives. If that ever starts depending on the status,
 *    skew goes dark in the browser.
 *
 * Source-text assertions on purpose: these are facts about the INSTALLED Next.js, and reading it
 * back is the only check that moves when the dependency does.
 */
import fs from 'fs';
import path from 'path';

const NEXT_DIST = path.resolve(__dirname, '../../node_modules/next/dist');

function nextSource(relative: string): string {
  return fs.readFileSync(path.join(NEXT_DIST, relative), 'utf8');
}

describe('Next answers an unrecognized Server Action without a 500, and the browser still sees skew', () => {
  const handler = nextSource('server/app-render/action-handler.js');

  // Not asserted: the absence of the string "E975". Next 16.4 dropped generated error codes from
  // its dist entirely (vercel/next.js#97687), so that check would pass whatever the behaviour.

  it('catches every action-id lookup that can throw and answers it instead', () => {
    // getActionModIdOrError throws the "Failed to find Server Action" error; each call must be
    // caught and handed to handleUnrecognizedAction, or that throw becomes a 500 again.
    const lookups = handler.match(/actionModId = getActionModIdOrError\(/g) ?? [];
    const answered =
      handler.match(
        /actionModId = getActionModIdOrError\(actionId, serverModuleMap\);\s*\} catch \(err\) \{\s*return handleUnrecognizedAction\(/g,
      ) ?? [];
    expect(lookups.length).toBeGreaterThan(0);
    expect(answered).toHaveLength(lookups.length);
  });

  it('routes an invalid multipart action to handleUnrecognizedAction in both the node and edge halves', () => {
    // The exact branch that used to throw E975. Two copies: the edge-runtime half and the node half.
    const answered = handler.match(
      /if \(!areAllActionIdsValid\(formData, serverModuleMap\)\) \{\s*return handleUnrecognizedAction\(/g,
    );
    expect(answered).toHaveLength(2);
  });

  it('handleUnrecognizedAction warns and responds — it does not throw', () => {
    const body = handler.match(
      /const handleUnrecognizedAction = \(err, statusCode\)=>\{([\s\S]*?)\n {4}\};/,
    )?.[1];
    expect(body).toBeDefined();
    expect(body).toContain('console.warn(err)');
    expect(body).toContain('res.statusCode = statusCode');
    expect(body).not.toMatch(/\bthrow\b/);
  });

  it('the browser raises UnrecognizedActionError from the not-found header, whatever the status', () => {
    const reducer = nextSource('client/components/router-reducer/reducers/server-action-reducer.js');
    expect(reducer).toMatch(
      /res\.headers\.get\(_approuterheaders\.NEXT_ACTION_NOT_FOUND_HEADER\);\s*if \(unrecognizedActionHeader === '1'\) \{\s*throw (?:Object\.defineProperty\()?new _unrecognizedactionerror\.UnrecognizedActionError\(/,
    );
    expect(reducer).not.toMatch(/res\.status === 40[49]/);
  });
});
