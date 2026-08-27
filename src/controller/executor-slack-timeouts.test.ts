/**
 * Slack transport timeout resolvers (the pre-public Slack fetch-timeout review fixes 1/3).
 *
 * Two env-overridable wall-clock budgets feed createSlackTransport:
 *   - SLACK_FETCH_TIMEOUT_MS → resolveSlackFetchTimeoutMs (JSON API + probe)
 *   - SLACK_UPLOAD_TIMEOUT_MS → resolveSlackUploadTimeoutMs (byte POST only)
 * Both follow resolveSlackMaxUploadBytes's validation idiom: an absent,
 * non-numeric, zero, or negative value falls back to the transport default.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { resolveSlackFetchTimeoutMs, resolveSlackUploadTimeoutMs } from './executor';
import { SLACK_FETCH_TIMEOUT_MS, SLACK_UPLOAD_TIMEOUT_MS } from '../channels/slack';

/** Set an env var to a literal, or delete it when the literal is `undefined`. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const prevFetch = process.env.SLACK_FETCH_TIMEOUT_MS;
const prevUpload = process.env.SLACK_UPLOAD_TIMEOUT_MS;

afterEach(() => {
  setEnv('SLACK_FETCH_TIMEOUT_MS', prevFetch);
  setEnv('SLACK_UPLOAD_TIMEOUT_MS', prevUpload);
});

describe('resolveSlackFetchTimeoutMs — env override with default fallback', () => {
  it('returns the default when the env var is absent', () => {
    setEnv('SLACK_FETCH_TIMEOUT_MS', undefined);
    expect(resolveSlackFetchTimeoutMs()).toBe(SLACK_FETCH_TIMEOUT_MS);
  });

  it('honors a valid positive integer override', () => {
    setEnv('SLACK_FETCH_TIMEOUT_MS', '12345');
    expect(resolveSlackFetchTimeoutMs()).toBe(12345);
  });

  it('falls back to the default on non-numeric, zero, or negative values', () => {
    for (const bad of ['abc', '0', '-5', '', '10.5', 'NaN']) {
      setEnv('SLACK_FETCH_TIMEOUT_MS', bad);
      expect(resolveSlackFetchTimeoutMs()).toBe(SLACK_FETCH_TIMEOUT_MS);
    }
  });
});

describe('resolveSlackUploadTimeoutMs — env override with default fallback', () => {
  it('returns the default when the env var is absent', () => {
    setEnv('SLACK_UPLOAD_TIMEOUT_MS', undefined);
    expect(resolveSlackUploadTimeoutMs()).toBe(SLACK_UPLOAD_TIMEOUT_MS);
  });

  it('honors a valid positive integer override', () => {
    setEnv('SLACK_UPLOAD_TIMEOUT_MS', '600000');
    expect(resolveSlackUploadTimeoutMs()).toBe(600000);
  });

  it('falls back to the default on non-numeric, zero, or negative values', () => {
    for (const bad of ['abc', '0', '-1', '', '3.14', 'NaN']) {
      setEnv('SLACK_UPLOAD_TIMEOUT_MS', bad);
      expect(resolveSlackUploadTimeoutMs()).toBe(SLACK_UPLOAD_TIMEOUT_MS);
    }
  });

  it('the upload default is larger than the fetch default (byte transfers get a longer budget)', () => {
    expect(SLACK_UPLOAD_TIMEOUT_MS).toBeGreaterThan(SLACK_FETCH_TIMEOUT_MS);
  });
});
