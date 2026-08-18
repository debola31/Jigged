import { isIP } from 'net';

/**
 * Determining the client address behind Vercel's proxy, for the clickwrap record.
 *
 * THE NAIVE VERSION IS WRONG. A client can put anything in `X-Forwarded-For`,
 * and whether the LEFTMOST entry is the true client depends entirely on whether
 * the terminating proxy REPLACES the header (leftmost correct) or APPENDS to it
 * (leftmost is whatever the attacker typed). Guidance on the internet assumes
 * replace; a record that a court might read should not rest on that assumption.
 *
 * So, in order:
 *
 *   1. Prefer `x-real-ip`. Vercel sets it to the address it determined, and it
 *      is single-valued, so append-vs-replace never arises.
 *   2. Fall back to `x-forwarded-for`, taking the entry TRUSTED_PROXY_HOPS from
 *      the RIGHT. Under replace there is one entry and the choice is free; under
 *      append the rightmost entries are the proxies' and the leftmost is the only
 *      one a client controls. Rightmost is correct-or-equal under both.
 *   3. Otherwise `null`, with source `unavailable`.
 *
 * RESIDUAL EXPOSURE, NAMED RATHER THAN HIDDEN: if `x-real-ip` is ever absent AND
 * a second trusted proxy is introduced without raising TRUSTED_PROXY_HOPS, this
 * records an internal hop. That is wrong, but it is not FORGEABLE -- which is
 * the failure direction to prefer in a legal record. The opposite mistake hands
 * an attacker the ability to write their own address into evidence.
 *
 * NEVER A SENTINEL. When the address genuinely cannot be determined the answer
 * is null. `0.0.0.0` or `127.0.0.1` would be a fabricated fact inside a legal
 * record -- the silent-fallback failure mode where it is least survivable.
 */

export type IpSource = 'x-real-ip' | 'x-forwarded-for' | 'unavailable';

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
