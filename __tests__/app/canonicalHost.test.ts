import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * **One host answers 200, and every URL we publish must name it.**
 *
 * This guard exists because the *mismatch* — not the choice of host — has now caused two
 * production incidents, and neither one was visible to a human:
 *
 *   - The live Stripe webhook was registered on a host that answered `307`. Stripe does not follow
 *     redirects, so **no live event was delivered for five days** (#695). Vercel's edge router
 *     issues the redirect before the function is invoked, so there was no exception, nothing in
 *     Sentry, and nothing in our logs — the first signal was Stripe's auto-disable warning.
 *   - The invite email carried a logo on the redirecting host. Outlook commonly declines to follow
 *     a redirect when loading a remote image, so it rendered as a broken box on the one message
 *     that most needs to look legitimate, feeding the junk classification that delayed the click
 *     (#722).
 *
 * Same root cause both times: **browsers follow redirects and machines often don't.** That
 * asymmetry is why the mismatch survived months of humans using the site perfectly happily.
 *
 * So the canonical host is asserted here rather than trusted to the four comments that explain it.
 * Nothing else in the repo fails when someone "tidies" one of these literals — `metadataBase`,
 * `og:url`, the email base URL and the two webhook registrations are all just strings, and a wrong
 * one is silent until a third party quietly stops reaching us.
 *
 * **If the canonical host ever moves again**, this test is the checklist: change `CANONICAL_HOST`,
 * watch it list every literal that still disagrees, and remember that the literals it cannot see
 * are the dangerous half — the Stripe and Intuit dashboard registrations, Supabase's `SITE_URL`
 * secret and redirect allowlist, `ALLOWED_ORIGINS`, `NEXT_PUBLIC_SCAN_ORIGIN` and the PostHog and
 * Sentry origin allowlists all live outside this repo. See docs/modules/billing.md § "The
 * production webhook URL".
 */
const CANONICAL_HOST = 'jigged.app';

/** Trees where a `https://…jigged.app` literal is a URL we publish or register. */
const ROOTS = ['app', 'components', 'lib', 'utils', 'supabase/functions', '.github/workflows'];

const SOURCE_EXT = ['.ts', '.tsx', '.mjs', '.yml', '.yaml'];

/**
 * `preview.jigged.app` is a deliberate second host, not a drift: it is the stable alias Intuit's
 * OAuth redirect is registered against, because a per-deployment preview URL cannot be
 * pre-registered. See `.github/workflows/preview-alias.yml`.
 */
const ALLOWED_SUBDOMAINS = new Set(['preview']);

/** Any absolute Jigged web URL. `hello@jigged.app` and bare prose mentions can't match. */
const JIGGED_URL = /https:\/\/((?:[a-z0-9-]+\.)*)jigged\.app/g;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      return walk(full);
    }
    return SOURCE_EXT.some((e) => entry.name.endsWith(e)) ? [full] : [];
  });
}

/**
 * Blank comment bodies so prose *about* the old host isn't read as a use of it — the fix for this
 * rule necessarily documents the host it replaced, in several files. Comment characters become
 * spaces rather than vanishing, so reported line numbers stay true.
 *
 * YAML uses `#`, TS uses `//` and block comments; a `#` inside a TS string is not a comment, so
 * the two dialects are handled by extension rather than merged.
 */
function blankComments(source: string, file: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  if (file.endsWith('.yml') || file.endsWith('.yaml')) {
    return source.replace(/(^|\s)#[^\n]*/g, blank);
  }
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, blank);
}

const files = ROOTS.flatMap((r) => walk(path.resolve(__dirname, '../..', r)));

describe('every published Jigged URL names the canonical host', () => {
  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it(`uses https://${CANONICAL_HOST} everywhere, with no redirecting host in code`, () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = blankComments(fs.readFileSync(file, 'utf8'), file);
      for (const match of source.matchAll(JIGGED_URL)) {
        const sub = match[1].replace(/\.$/, '');
        if (sub === '' || ALLOWED_SUBDOMAINS.has(sub)) continue;
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(process.cwd(), file)}:${line} — ${match[0]}`);
      }
    }

    expect(offenders, `Not the canonical host (https://${CANONICAL_HOST}):\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * The three literals a redirect actually costs us, asserted by name.
 *
 * The sweep above would catch a wrong host in these files too, but it would not catch someone
 * *deleting* `metadataBase` or the `SITE_URL` fallback — and a missing canonical URL is its own
 * bug. These pin that the declaration exists at all.
 */
describe('the load-bearing declarations', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

  it('app/layout.tsx sets metadataBase and og:url to the canonical origin', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain(`metadataBase: new URL('https://${CANONICAL_HOST}')`);
    expect(layout).toContain(`url: 'https://${CANONICAL_HOST}'`);
  });

  it('the email base URL falls back to the canonical origin', () => {
    expect(read('supabase/functions/_shared/email.ts')).toContain(
      `Deno.env.get('SITE_URL') ?? 'https://${CANONICAL_HOST}'`
    );
  });
});
