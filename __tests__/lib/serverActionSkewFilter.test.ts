/**
 * Pins a Sentry filter AND the Next.js string it depends on.
 *
 * Sentry JAVASCRIPT-NEXTJS-3A was 12 unhandled 500s on `POST /(marketing)/page` — Next **E975**,
 * thrown for a generic `multipart/form-data` POST that carries no `Next-Action` header and no
 * `$ACTION_*` fields at all. Two AS400463 datacenter IPs, zero PostHog events in the window, no
 * `waitlist` row: a scanner, and a request no browser running this app can send.
 *
 * These assert BEHAVIOUR OF THE SENTRY SDK, not of our code, which is why they are worth having:
 * `ignoreErrors` matches strings with `includes()` and RegExps with `.test()` against the WHOLE
 * multi-line `exception.values[0].value`. The filter is only correct while that holds, and an SDK
 * upgrade would change it silently.
 *
 * Two things worth knowing before editing, both learned in
 * `__tests__/lib/supabaseSentryIntegration.test.ts`:
 *   - `beforeSend` runs during `flush`, NOT when `captureException` returns.
 *   - A second `Sentry.init` in one file routes events to the FIRST client. One `init` per file.
 *
 * `beforeSend` is a safe recorder here precisely because `ignoreErrors` runs earlier, in the
 * integration's `processEvent` — anything this records is something the filter let through.
 */
import * as Sentry from '@sentry/nextjs';
import fs from 'fs';
import path from 'path';
import { GENERIC_MULTIPART_POST_E975 } from '@/lib/sentryEventPolicy';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** The exact literal Next throws. Asserted against the installed Next.js in its own test below. */
const E975 =
  'Failed to find Server Action. This request might be from an older or newer deployment.\n' +
  'Read more: https://nextjs.org/docs/messages/failed-to-find-server-action';

const kept: string[] = [];

beforeAll(() => {
  Sentry.init({
    dsn: 'https://abc123@o1.ingest.us.sentry.io/1',
    enabled: true,
    ignoreErrors: [GENERIC_MULTIPART_POST_E975],
    beforeSend(event) {
      kept.push(event.exception?.values?.[0]?.value ?? '');
      return null;
    },
    transport: () => ({ send: async () => ({}), flush: async () => true }),
  });
});

beforeEach(() => {
  kept.length = 0;
});

async function capture(err: Error): Promise<string[]> {
  Sentry.captureException(err);
  await Sentry.flush(2000);
  return kept;
}

/** `dedupeIntegration` is on by default, so every kept case needs a distinct message. */
function named(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('Next E975 is filtered, and every sibling that means a real user is not', () => {
  it('drops the E975 throw — a generic multipart POST no browser of ours can send', async () => {
    expect(await capture(new Error(E975))).toEqual([]);
  });

  it('keeps the quoted-id sibling, which IS deployment skew', async () => {
    // getActionNotFoundError() in manifests-singleton.js — the same sentence with an id in the
    // middle. Reached on the fetch-action path, and the `\.` after `Action` is all that separates
    // the two. If this ever starts being dropped, real skew goes dark server-side.
    const message =
      'Failed to find Server Action "7f9ab12c". This request might be from an older or newer ' +
      'deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action';
    expect(await capture(new Error(message))).toHaveLength(1);
  });

  it('keeps the browser-side E715 — the one signal a real prospect hit skew', async () => {
    // server-action-reducer.js throws this when the server answers 404 with
    // x-nextjs-action-not-found. It is what lib/serverActionSkew.ts reports at `error` level.
    // Named, so the `${type}: ${value}` candidate Sentry also builds is exercised.
    const err = named(
      'UnrecognizedActionError',
      'Server Action "7f9ab12c" was not found on the server. \n' +
        'Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    );
    expect(await capture(err)).toHaveLength(1);
  });

  it('keeps an error that merely WRAPS the E975 text — this is what the `^` buys', async () => {
    // Sentry matches STRING patterns with includes(), so a plain-string entry would drop this:
    // a different failure, with a different cause, silently swallowed. Anyone "simplifying" the
    // RegExp into a string fails here.
    expect(await capture(new Error(`Rendering / failed: ${E975}`))).toHaveLength(1);
  });

  it('still matches the message the installed Next.js actually throws', async () => {
    // A Next upgrade that rewords this leaves the filter matching nothing and the noise returns
    // silently. Fail here instead. Both halves of action-handler.js carry the identical literal.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'node_modules/next/dist/server/app-render/action-handler.js'),
      'utf8',
    );
    expect(source).toContain(E975.split('\n')[0]);
    expect(source).toContain('"E975"');
    expect(GENERIC_MULTIPART_POST_E975.test(E975)).toBe(true);
  });

  it('finds no app route on the edge runtime, which is why sentry.edge.config.ts has no filter', () => {
    // Next throws the identical E975 from its edge branch. The edge config is deliberately left
    // without an `ignoreErrors` because nothing here can reach that branch: the only
    // `runtime = 'edge'` is app/opengraph-image.tsx, a GET metadata route that never enters
    // handleAction, and there is no middleware.ts. The day a page or route handler goes edge that
    // reasoning expires — and this is where it says so.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name.startsWith('.') ? [] : walk(full);
        return /^(page|route)\.tsx?$/.test(entry.name) ? [full] : [];
      });

    const routes = walk(path.join(REPO_ROOT, 'app'));
    expect(routes.length).toBeGreaterThan(20); // a silently-empty walk would pass forever

    const edge = routes.filter((file) =>
      /export\s+const\s+runtime\s*=\s*['"]edge['"]/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(edge).toEqual([]);
    expect(fs.existsSync(path.join(REPO_ROOT, 'middleware.ts'))).toBe(false);
  });
});
