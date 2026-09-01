import { describe, expect, it } from 'vitest';
import { assertFetchableUrl, assertPublicAddress, isPrivateAddress, SsrfBlockedError } from './ssrf';

/**
 * The SSRF guard's whole job is to say no to addresses that look fine.
 * Every case below is a URL a person could plausibly paste into a shop
 * config field.
 */

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'RFC 1918'],
    ['172.16.0.1', 'RFC 1918 lower bound'],
    ['172.31.255.255', 'RFC 1918 upper bound'],
    ['192.168.1.1', 'RFC 1918'],
    ['169.254.169.254', 'the cloud metadata endpoint'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata endpoint'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1', // just outside 172.16/12 — the off-by-one this table exists for
    '172.15.255.255',
    '192.167.0.1',
    '2606:4700:4700::1111',
  ])('permits the public address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('assertFetchableUrl', () => {
  it('permits an ordinary https URL', () => {
    expect(assertFetchableUrl('https://graph.facebook.com/v21.0/media').host).toBe(
      'graph.facebook.com',
    );
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'the AWS metadata endpoint'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'the GCP metadata endpoint'],
    ['http://localhost:5432/', 'a database on the loopback interface'],
    ['https://10.0.0.5/', 'a private address'],
    ['https://[::1]/', 'IPv6 loopback in bracket form'],
    ['file:///etc/passwd', 'a non-HTTP scheme'],
    ['gopher://evil.example/', 'a protocol-smuggling scheme'],
    ['https://user:pass@evil.example/', 'embedded credentials'],
    ['https://evil.example:22/', 'a non-web port'],
    ['not a url at all', 'unparseable input'],
  ])('refuses %s (%s)', (url) => {
    expect(() => assertFetchableUrl(url)).toThrow(SsrfBlockedError);
  });

  it('permits the private ranges only when the dev stack asks for it', () => {
    expect(() => assertFetchableUrl('http://localhost:9000/bucket')).toThrow(SsrfBlockedError);
    expect(
      assertFetchableUrl('http://localhost:9000/bucket', {
        allowPrivate: true,
        allowedProtocols: ['http:', 'https:'],
      }).port,
    ).toBe('9000');
  });

  it('names the rule it refused on', () => {
    // An SSRF block that says only "blocked" costs an operator an afternoon.
    try {
      assertFetchableUrl('https://10.0.0.5/x');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as SsrfBlockedError).rule).toContain('private');
      // And it must not echo the query string, which can carry a media token.
      expect((error as SsrfBlockedError).message).not.toContain('?');
    }
  });

  it('checks the address DNS actually returned, not only the literal', () => {
    // The parse-time check cannot see through a hostname; this is the hook the
    // fetch path calls from its socket lookup, and it is where the real
    // rebinding defence lives.
    expect(() => assertPublicAddress('169.254.169.254', 'https://harmless.example')).toThrow(
      SsrfBlockedError,
    );
    expect(() => assertPublicAddress('93.184.216.34')).not.toThrow();
  });
});
