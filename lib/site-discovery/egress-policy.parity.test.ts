import { describe, expect, it } from 'vitest';
import { IPV4_BLOCKED_PREFIXES, IPV6_BLOCKED_PREFIXES } from './egress-policy';

describe('egress policy parity tables', () => {
  it('matches the normative IPv4 table in order', () => {
    // Source: prequire-app lib/egress.php fp_ipv4_blocked_prefixes()/fp_ipv6_blocked_prefixes()
    expect(IPV4_BLOCKED_PREFIXES).toEqual([
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ]);
  });

  it('matches the normative IPv6 table in order', () => {
    // Source: prequire-app lib/egress.php fp_ipv4_blocked_prefixes()/fp_ipv6_blocked_prefixes()
    expect(IPV6_BLOCKED_PREFIXES).toEqual([
      ['2001::', 32],
      ['2001:2::', 48],
      ['2001:10::', 28],
      ['2001:20::', 28],
      ['2001:db8::', 32],
      ['2002::', 16],
    ]);
  });
});
