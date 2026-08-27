/**
 * Proxy resolution for the Socket Mode dial (the original Socket Mode proxy work).
 *
 * `fetch` honours the conventional proxy environment variables; Bun's
 * `WebSocket` does not read them, though it DOES accept an explicit `proxy`
 * option. The asymmetry is invisible until an operator tries to build a
 * default-deny egress policy: every HTTP path the kernel uses routes through
 * their proxy, the Socket Mode connection silently goes direct, and closing
 * the remaining hole kills the listener with no indication why.
 *
 * This module is the missing half — it resolves what `fetch` would have used,
 * so the dial can pass it through and operators get ONE consistent knob.
 *
 * Semantics follow the de-facto convention shared by curl, requests, Go and
 * fetch itself, because an operator's existing NO_PROXY is already written
 * against it:
 *   - `wss:`/`https:` prefer HTTPS_PROXY, falling back to HTTP_PROXY;
 *     `ws:`/`http:` use HTTP_PROXY only. (An https-only proxy setting must not
 *     be silently applied to cleartext, and vice versa.)
 *   - lowercase names win over uppercase when both are set, matching curl.
 *   - NO_PROXY entries match the host exactly, or as a domain suffix
 *     (`.slack.com` and `slack.com` both match `wss-primary.slack.com`).
 *     `*` disables proxying entirely.
 *   - A NO_PROXY entry may carry a port (`slack.com:443`), which must then
 *     match the URL's effective port.
 *
 * Deliberately env-in-args rather than reading `process.env` directly: the
 * resolution is the part with the edge cases, so it is a pure function the
 * tests can drive exhaustively.
 */

/** The subset of the environment this resolver reads. */
export type ProxyEnv = Record<string, string | undefined>;

/** Default ports, for NO_PROXY entries that pin one. */
const DEFAULT_PORTS: Record<string, string> = {
  'ws:': '80',
  'http:': '80',
  'wss:': '443',
  'https:': '443',
};

/** Lowercase wins over uppercase — curl's precedence, and the common case. */
function readEnv(env: ProxyEnv, name: string): string | undefined {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * True when NO_PROXY exempts this host. Entries are comma (or whitespace)
 * separated; a bare `*` exempts everything.
 */
export function isProxyExempt(url: URL, env: ProxyEnv): boolean {
  const raw = readEnv(env, 'NO_PROXY');
  if (raw === undefined) return false;

  const host = url.hostname.toLowerCase();
  const port = url.port !== '' ? url.port : (DEFAULT_PORTS[url.protocol] ?? '');

  for (const entryRaw of raw.split(/[,\s]+/)) {
    const entry = entryRaw.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (entry === '*') return true;

    // An entry may pin a port: `slack.com:443` exempts only that port.
    const colon = entry.lastIndexOf(':');
    let pattern = entry;
    let entryPort: string | undefined;
    if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
      pattern = entry.slice(0, colon);
      entryPort = entry.slice(colon + 1);
    }
    if (entryPort !== undefined && entryPort !== port) continue;

    // Leading dot is optional: `.slack.com` and `slack.com` both match the
    // domain and its subdomains. Never let `notslack.com` match `slack.com`.
    const bare = pattern.startsWith('.') ? pattern.slice(1) : pattern;
    if (bare.length === 0) continue;
    if (host === bare || host.endsWith('.' + bare)) return true;
  }
  return false;
}

/**
 * The proxy URL to dial `target` through, or undefined for a direct
 * connection. Returns the value verbatim so credentials embedded in it
 * (`http://user:pass@proxy:8080`) reach the dialer intact.
 *
 * Never throws: a malformed target or proxy setting resolves to "no proxy"
 * rather than taking the listener down at startup. The caller logs the choice,
 * so a typo surfaces as an unproxied connection in the log rather than a crash.
 */
export function resolveSocketProxy(target: string, env: ProxyEnv): string | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }

  if (isProxyExempt(url, env)) return undefined;

  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  const proxy = secure
    ? (readEnv(env, 'HTTPS_PROXY') ?? readEnv(env, 'HTTP_PROXY'))
    : readEnv(env, 'HTTP_PROXY');
  if (proxy === undefined) return undefined;

  // Reject anything that is not a usable http(s) proxy origin rather than
  // handing the dialer a string it will fail on opaquely.
  try {
    const parsed = new URL(proxy);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return proxy;
}

/**
 * The second argument for the WebSocket constructor, or undefined when the
 * dial should be made bare.
 *
 * Exists so the wiring is testable without opening a socket. The distinction
 * it encodes is load-bearing: passing `{ proxy: undefined }` is NOT the same as
 * omitting the argument — the option bag is truthy, and a transport is entitled
 * to treat "proxy key present" differently from "no options at all". Returning
 * undefined for the no-proxy case keeps the caller's bare dial genuinely bare.
 */
export function socketDialOptions(target: string, env: ProxyEnv): { proxy: string } | undefined {
  const proxy = resolveSocketProxy(target, env);
  return proxy === undefined ? undefined : { proxy };
}
