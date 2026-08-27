/**
 * Tests for Socket Mode proxy resolution (the original Socket Mode proxy work).
 *
 * Contract pinned here:
 *   - the scheme decides which variable applies: an HTTPS_PROXY must not be
 *     silently applied to a cleartext ws:, nor an HTTP_PROXY-only setting be
 *     ignored for wss: (fetch falls back, so we do too);
 *   - lowercase beats uppercase, matching curl, because operators' existing
 *     environments are already written against that precedence;
 *   - NO_PROXY exempts by exact host, by domain suffix, and by `*`, and
 *     `notslack.com` never matches `slack.com`;
 *   - resolution NEVER throws — a typo yields a direct connection that the
 *     caller can log, not a listener that dies at startup.
 */
import { describe, it, expect } from 'bun:test';
import { resolveSocketProxy, isProxyExempt, socketDialOptions } from './socket-proxy';

const WSS = 'wss://wss-primary.slack.com/link/?ticket=abc';
const WS = 'ws://internal.example/socket';

describe('resolveSocketProxy — scheme selects the variable', () => {
  it('uses HTTPS_PROXY for wss:', () => {
    expect(resolveSocketProxy(WSS, { HTTPS_PROXY: 'http://proxy:8080' })).toBe('http://proxy:8080');
  });

  it('falls back to HTTP_PROXY for wss: when HTTPS_PROXY is unset (fetch does)', () => {
    expect(resolveSocketProxy(WSS, { HTTP_PROXY: 'http://proxy:8080' })).toBe('http://proxy:8080');
  });

  it('does NOT apply an https-only proxy setting to cleartext ws:', () => {
    expect(resolveSocketProxy(WS, { HTTPS_PROXY: 'http://proxy:8080' })).toBeUndefined();
  });

  it('uses HTTP_PROXY for ws:', () => {
    expect(resolveSocketProxy(WS, { HTTP_PROXY: 'http://proxy:8080' })).toBe('http://proxy:8080');
  });

  it('prefers HTTPS_PROXY over HTTP_PROXY for wss:', () => {
    expect(
      resolveSocketProxy(WSS, { HTTPS_PROXY: 'http://secure:1', HTTP_PROXY: 'http://plain:2' }),
    ).toBe('http://secure:1');
  });
});

describe('resolveSocketProxy — env name precedence', () => {
  it('prefers lowercase over uppercase, as curl does', () => {
    expect(
      resolveSocketProxy(WSS, { https_proxy: 'http://lower:1', HTTPS_PROXY: 'http://upper:2' }),
    ).toBe('http://lower:1');
  });

  it('accepts uppercase when that is all there is', () => {
    expect(resolveSocketProxy(WSS, { HTTPS_PROXY: 'http://upper:2' })).toBe('http://upper:2');
  });

  it('treats empty or whitespace-only settings as unset', () => {
    expect(resolveSocketProxy(WSS, { HTTPS_PROXY: '' })).toBeUndefined();
    expect(resolveSocketProxy(WSS, { HTTPS_PROXY: '   ' })).toBeUndefined();
  });
});

describe('resolveSocketProxy — credentials pass through', () => {
  it('returns the setting verbatim so embedded credentials survive', () => {
    const withCreds = 'http://user:pa%40ss@proxy.internal:8080';
    expect(resolveSocketProxy(WSS, { HTTPS_PROXY: withCreds })).toBe(withCreds);
  });
});

describe('NO_PROXY', () => {
  it('exempts an exact host', () => {
    expect(
      resolveSocketProxy(WSS, {
        HTTPS_PROXY: 'http://proxy:8080',
        NO_PROXY: 'wss-primary.slack.com',
      }),
    ).toBeUndefined();
  });

  it('exempts by domain suffix, with or without the leading dot', () => {
    for (const entry of ['.slack.com', 'slack.com']) {
      expect(
        resolveSocketProxy(WSS, { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: entry }),
      ).toBeUndefined();
    }
  });

  it('does not let a suffix match spill across domain boundaries', () => {
    // The bug this guards: endsWith('slack.com') would wrongly exempt
    // notslack.com, quietly sending traffic direct that policy says to proxy.
    expect(
      isProxyExempt(new URL('wss://notslack.com/x'), { NO_PROXY: 'slack.com' }),
    ).toBe(false);
  });

  it('honours `*` as exempt-everything', () => {
    expect(resolveSocketProxy(WSS, { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: '*' })).toBeUndefined();
  });

  it('splits on commas and whitespace, ignoring empties', () => {
    expect(
      resolveSocketProxy(WSS, {
        HTTPS_PROXY: 'http://proxy:8080',
        NO_PROXY: 'example.com, , .slack.com   other.test',
      }),
    ).toBeUndefined();
  });

  it('respects a port pinned on the entry', () => {
    // wss: defaults to 443, so :443 matches and :8443 does not.
    expect(
      resolveSocketProxy(WSS, { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'slack.com:443' }),
    ).toBeUndefined();
    expect(
      resolveSocketProxy(WSS, { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'slack.com:8443' }),
    ).toBe('http://proxy:8080');
  });

  it('is case-insensitive on the host', () => {
    expect(
      isProxyExempt(new URL('wss://WSS-Primary.Slack.COM/x'), { NO_PROXY: 'slack.com' }),
    ).toBe(true);
  });
});

describe('resolveSocketProxy — never throws', () => {
  it('returns undefined for an unparseable target', () => {
    expect(resolveSocketProxy('not a url', { HTTPS_PROXY: 'http://proxy:8080' })).toBeUndefined();
  });

  it('returns undefined for an unparseable proxy setting', () => {
    expect(resolveSocketProxy(WSS, { HTTPS_PROXY: '://////' })).toBeUndefined();
  });

  it('rejects a proxy setting that is not http(s)', () => {
    // socks5 is a real thing operators set, and Bun's WebSocket proxy option
    // does not speak it — better a logged direct connection than an opaque
    // dial failure at runtime.
    expect(resolveSocketProxy(WSS, { HTTPS_PROXY: 'socks5://proxy:1080' })).toBeUndefined();
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveSocketProxy(WSS, {})).toBeUndefined();
  });
});

describe('socketDialOptions — the wiring the dial actually uses', () => {
  it('returns undefined when no proxy applies, so the dial stays bare', () => {
    expect(socketDialOptions(WSS, {})).toBeUndefined();
  });

  it('never returns { proxy: undefined }', () => {
    // The distinction matters: an option bag is truthy, and a transport may
    // treat "proxy key present but undefined" differently from "no options".
    const opts = socketDialOptions(WSS, {});
    expect(opts).toBeUndefined();
    expect(opts?.proxy).toBeUndefined();
  });

  it('wraps the resolved proxy for the constructor', () => {
    expect(socketDialOptions(WSS, { HTTPS_PROXY: 'http://proxy:8080' })).toEqual({
      proxy: 'http://proxy:8080',
    });
  });

  it('honours NO_PROXY, so an exempt host dials bare even with a proxy set', () => {
    expect(
      socketDialOptions(WSS, { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: '.slack.com' }),
    ).toBeUndefined();
  });
});
