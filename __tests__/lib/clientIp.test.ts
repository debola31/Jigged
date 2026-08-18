import { describe, it, expect } from 'vitest';
import { resolveClientIp, stripPort, boundedUserAgent, TRUSTED_PROXY_HOPS } from '@/lib/clientIp';

const h = (init: Record<string, string>) => new Headers(init);

describe('clientIp — stripPort', () => {
  it('strips a port from IPv4', () => {
    expect(stripPort('203.0.113.7:8080')).toBe('203.0.113.7');
  });

  it('strips a port from bracketed IPv6', () => {
    expect(stripPort('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  /**
   * THE CASE THIS EXISTS FOR. A bare IPv6 address is full of colons and has no
   * port. Naive "split on the last colon" mangles it into something isIP()
   * rejects, and the row silently records no address at all.
   */
  it('leaves a bare IPv6 address intact', () => {
    expect(stripPort('2001:db8::1')).toBe('2001:db8::1');
    expect(stripPort('::1')).toBe('::1');
  });
});

describe('clientIp — source preference', () => {
  it('prefers x-real-ip', () => {
    expect(resolveClientIp(h({ 'x-real-ip': '203.0.113.7' }))).toEqual({
      ip: '203.0.113.7',
      source: 'x-real-ip',
    });
  });

  /**
   * The spoofing case. A client can send its own X-Forwarded-For; x-real-ip is
   * set by the platform. Preferring the platform's value is what stops a caller
   * writing their chosen address into a legal record.
   */
  it('prefers the platform header over a client-supplied X-Forwarded-For', () => {
    const r = resolveClientIp(
      h({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '10.9.9.9, 198.51.100.1' }),
    );
    expect(r.ip).toBe('203.0.113.7');
    expect(r.source).toBe('x-real-ip');
  });

  it('falls through to XFF when x-real-ip is garbage', () => {
    const r = resolveClientIp(h({ 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.1' }));
    expect(r).toEqual({ ip: '198.51.100.1', source: 'x-forwarded-for' });
  });

  /**
   * Rightmost, NOT leftmost. Leftmost is correct only if the terminating proxy
   * replaces the header; if it appends, leftmost is whatever the attacker typed.
   * Rightmost is correct-or-equal under both behaviours.
   */
  it('takes the XFF entry TRUSTED_PROXY_HOPS from the right', () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1);
    const r = resolveClientIp(h({ 'x-forwarded-for': '10.0.0.1, 198.51.100.1' }));
    expect(r.ip).toBe('198.51.100.1');
  });

  it('handles a single-entry XFF', () => {
    expect(resolveClientIp(h({ 'x-forwarded-for': '198.51.100.1' })).ip).toBe('198.51.100.1');
  });
});

describe('clientIp — absent or hostile input', () => {
  /**
   * The row is still written. "The server could not determine an address" is a
   * fact worth recording; refusing the acceptance over it would block an account
   * creation on a header.
   */
  it('reports unavailable rather than inventing an address', () => {
    expect(resolveClientIp(h({}))).toEqual({ ip: null, source: 'unavailable' });
  });

  it('never returns a loopback or wildcard sentinel for a missing header', () => {
    const r = resolveClientIp(h({}));
    expect(r.ip).not.toBe('127.0.0.1');
    expect(r.ip).not.toBe('0.0.0.0');
    expect(r.ip).toBeNull();
  });

  it('reports unavailable when every entry is malformed', () => {
    expect(resolveClientIp(h({ 'x-forwarded-for': 'nope, also-nope' }))).toEqual({
      ip: null,
      source: 'unavailable',
    });
  });

  it('caps an oversized header instead of grinding on it', () => {
    const flood = new Array(5000).fill('1.2.3.4').join(', ');
    expect(() => resolveClientIp(h({ 'x-forwarded-for': flood }))).not.toThrow();
    const huge = 'x'.repeat(9000);
    expect(resolveClientIp(h({ 'x-real-ip': huge })).source).toBe('unavailable');
  });

  it('accepts a private address — recording what was observed beats recording nothing', () => {
    expect(resolveClientIp(h({ 'x-real-ip': '10.0.0.5' })).ip).toBe('10.0.0.5');
  });

  /**
   * Stored as observed. Normalising `::ffff:203.0.113.7` to its IPv4 form would
   * be a transformation of evidence, and inet holds it either way.
   */
  it('stores an IPv4-mapped IPv6 address as observed', () => {
    expect(resolveClientIp(h({ 'x-real-ip': '::ffff:203.0.113.7' })).ip).toBe(
      '::ffff:203.0.113.7',
    );
  });

  it('reads a bracketed IPv6 with a port', () => {
    expect(resolveClientIp(h({ 'x-real-ip': '[2001:db8::1]:443' })).ip).toBe('2001:db8::1');
  });
});

describe('clientIp — user agent', () => {
  it('bounds the user agent to the column CHECK', () => {
    expect(boundedUserAgent(h({ 'user-agent': 'x'.repeat(2000) }))!.length).toBe(1024);
  });

  it('returns null when absent, so "absent" is one value and not two', () => {
    expect(boundedUserAgent(h({}))).toBeNull();
    expect(boundedUserAgent(h({ 'user-agent': '' }))).toBeNull();
  });
});
