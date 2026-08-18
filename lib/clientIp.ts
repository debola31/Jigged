import { isIP } from 'net';

/**
 * Determining the client address behind Vercel's proxy, for the clickwrap record.
 *
 * WHAT VERCEL ACTUALLY DOES, from its request-header documentation -- the
 * question this function was designed around, now settled rather than assumed:
 *
 *   x-forwarded-for        "we currently OVERWRITE the X-Forwarded-For header
 *                           and do not forward external IPs. This restriction is
 *                           in place to prevent IP spoofing."
 *   x-real-ip              "identical to the x-forwarded-for header."
 *   x-vercel-forwarded-for "identical to x-forwarded-for. HOWEVER,
 *                           x-forwarded-for could be overwritten if you're using
 *                           a proxy on top of Vercel."
 *
 * So a caller CANNOT spoof their address here: Vercel replaces the header rather
 * than appending to it, and honouring a caller's own X-Forwarded-For is a
 * purchased Enterprise "Trusted Proxy" feature that is not enabled on this
 * project. The leftmost-vs-rightmost question that shapes this code on other
 * platforms is therefore moot today -- there is exactly one entry.
 *
 * Preference order, most trustworthy first:
 *
 *   1. `x-vercel-forwarded-for` -- the only one of the three a proxy placed IN
 *      FRONT of Vercel cannot overwrite. Nothing sits in front today; this is
 *      cheap insurance for the day a CDN or WAF does, because by then these rows
 *      will be years old and nobody will revisit this file.
 *   2. `x-real-ip` -- Vercel's own value, single-valued.
 *   3. `x-forwarded-for`, taking the entry TRUSTED_PROXY_HOPS from the RIGHT.
 *      Moot under replace; correct-or-equal if that ever changes.
 *   4. Otherwise `null`, with source `unavailable`.
 *
 * Recording WHICH header answered is the point of `ip_source`: it is what lets a
 * reader years from now tell a platform-observed address from a proxy-reported
 * one, instead of having to trust that this comment was still true.
 *
 * NEVER A SENTINEL. When the address genuinely cannot be determined the answer
 * is null. `0.0.0.0` or `127.0.0.1` would be a fabricated fact inside a legal
 * record -- the silent-fallback failure mode where it is least survivable.
 */

export type IpSource =
  | 'x-vercel-forwarded-for'
  | 'x-real-ip'
  | 'x-forwarded-for'
  | 'unavailable';

export interface ResolvedIp {
  ip: string | null;
  source: IpSource;
}

/** How many proxies we trust to have appended to X-Forwarded-For. Vercel is one.
 *  Raising this is a security decision: each increment moves the entry we read
 *  one hop closer to the client, and one hop closer to attacker-controlled. */
export const TRUSTED_PROXY_HOPS = 1;

/** Defensive bounds. A header is attacker-influenced input, and splitting a
 *  megabyte of commas to find one address is a free CPU burn. */
const MAX_HEADER_LENGTH = 8 * 1024;
const MAX_ENTRIES = 32;

/**
 * Strips a port when one is unambiguously present.
 *
 * `[2001:db8::1]:443` -> `2001:db8::1`; `203.0.113.7:8080` -> `203.0.113.7`.
 * A BARE IPv6 like `2001:db8::1` has many colons and no port, and must survive
 * intact -- which is why the port is only stripped when there is exactly one
 * colon, or when the address is bracketed.
 */
export function stripPort(value: string): string {
  const raw = value.trim();
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close > 0) return raw.slice(1, close);
    return raw;
  }
  const colons = (raw.match(/:/g) ?? []).length;
  if (colons === 1) return raw.slice(0, raw.lastIndexOf(':'));
  return raw;
}

function firstValid(values: string[]): string | null {
  for (const v of values) {
    const candidate = stripPort(v);
    if (isIP(candidate)) return candidate;
  }
  return null;
}

export function resolveClientIp(headers: Headers): ResolvedIp {
  const vercelIp = headers.get('x-vercel-forwarded-for');
  if (vercelIp && vercelIp.length <= MAX_HEADER_LENGTH) {
    const candidate = stripPort((vercelIp.split(',')[0] ?? '').trim());
    if (isIP(candidate)) return { ip: candidate, source: 'x-vercel-forwarded-for' };
  }

  const realIp = headers.get('x-real-ip');
  if (realIp && realIp.length <= MAX_HEADER_LENGTH) {
    const candidate = stripPort(realIp);
    // A garbage x-real-ip falls through to XFF rather than poisoning the result.
    if (isIP(candidate)) return { ip: candidate, source: 'x-real-ip' };
  }

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded && forwarded.length <= MAX_HEADER_LENGTH) {
    const entries = forwarded
      .split(',')
      .slice(-MAX_ENTRIES)
      .map((e) => e.trim())
      .filter(Boolean);

    if (entries.length) {
      // Count from the right: index length-1 is the nearest proxy's view.
      const index = Math.max(0, entries.length - TRUSTED_PROXY_HOPS);
      const preferred = entries.slice(index, index + 1);
      const ip = firstValid(preferred) ?? firstValid([...entries].reverse());
      if (ip) return { ip, source: 'x-forwarded-for' };
    }
  }

  return { ip: null, source: 'unavailable' };
}

/** The user agent, bounded to the column's CHECK. Returns null rather than an
 *  empty string so "absent" is one value in the record, not two. */
export function boundedUserAgent(headers: Headers, max = 1024): string | null {
  const ua = headers.get('user-agent');
  if (!ua) return null;
  const trimmed = ua.slice(0, max);
  return trimmed.length ? trimmed : null;
}
