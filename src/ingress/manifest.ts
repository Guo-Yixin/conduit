/**
 * Engine manifest (the original multi-flow engine work, capability 1/2 — one daemon hosts N flows).
 *
 * The manifest is the operator-facing declaration of which flows an engine
 * process hosts. It replaces unwieldy comma-joined `--flows name=path` lists
 * for real deployments (a new flow = one added line + restart), while the
 * inline form remains for single-flow/dev use.
 *
 *   # engine.yaml
 *   flows:
 *     pic-edit: ./flows/pic-edit/flow.yaml     # paths resolve relative to
 *     studio:   ./flows/studio/flow.yaml       # the manifest's directory
 *   global_alert_channel: "#conduit-ops"       # optional
 *   max_concurrent_runs: 2                     # optional run backpressure (the original listener-backpressure work)
 *
 * Config is validated, not trusted (design principle): unknown top-level
 * keys, a missing/empty flows map, or non-string entries are load errors —
 * never silently ignored. Per-flow *content* problems (bad flow.yaml) are NOT
 * this module's concern; the listener's quarantine handles those per-flow.
 */
import { parse } from 'yaml';
import { isAbsolute, resolve } from 'node:path';

export interface EngineManifest {
  /** flowName → absolute flow.yaml path (resolved against the manifest dir). */
  flows: Record<string, string>;
  /** Listener-global fallback alert channel (optional). */
  globalAlertChannel?: string;
  /**
   * Listener-wide run backpressure cap (the original listener-backpressure work): at most this many spawned
   * `conduit run` processes in flight at once across all hosted flows. Events
   * beyond the cap stay 'accepted' in ingress_events and launch as slots free.
   * Optional — omitted means unlimited.
   */
  maxConcurrentRuns?: number;
}

export interface ManifestError {
  code: string;
  message: string;
}

export type ParseManifestResult =
  | { ok: true; manifest: EngineManifest }
  | { ok: false; errors: ManifestError[] };

const KNOWN_TOP_LEVEL_KEYS = new Set(['flows', 'global_alert_channel', 'max_concurrent_runs']);

/** Flow names must be addressable in logs/CLI args — same charset as run ids. */
const FLOW_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Parse and validate an engine manifest.
 *
 * @param yamlText     Raw manifest file content.
 * @param manifestDir  Directory the manifest was read from — relative flow
 *                     paths resolve against it, so a manifest checked into a
 *                     deployment repo is position-independent.
 */
export function parseEngineManifest(yamlText: string, manifestDir: string): ParseManifestResult {
  const errors: ManifestError[] = [];

  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [{ code: 'MANIFEST_PARSE_ERROR', message: `manifest is not valid YAML: ${detail}` }] };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ code: 'MANIFEST_NOT_A_MAPPING', message: 'manifest must be a YAML mapping with a top-level `flows:` block' }],
    };
  }
  const doc = raw as Record<string, unknown>;

  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      errors.push({
        code: 'MANIFEST_UNKNOWN_KEY',
        message: `unknown top-level manifest key '${key}' — known keys: ${[...KNOWN_TOP_LEVEL_KEYS].join(', ')}`,
      });
    }
  }

  const rawFlows = doc['flows'];
  const flows: Record<string, string> = {};
  if (rawFlows === null || rawFlows === undefined) {
    errors.push({ code: 'MANIFEST_NO_FLOWS', message: 'manifest must declare a non-empty `flows:` mapping (flowName: path/to/flow.yaml)' });
  } else if (typeof rawFlows !== 'object' || Array.isArray(rawFlows)) {
    errors.push({ code: 'MANIFEST_FLOWS_NOT_A_MAPPING', message: '`flows:` must be a mapping of flowName → flow.yaml path' });
  } else {
    const entries = Object.entries(rawFlows as Record<string, unknown>);
    if (entries.length === 0) {
      errors.push({ code: 'MANIFEST_NO_FLOWS', message: '`flows:` is empty — an engine serving nothing is a misconfiguration, not a service' });
    }
    for (const [name, value] of entries) {
      if (!FLOW_NAME_PATTERN.test(name)) {
        errors.push({
          code: 'MANIFEST_INVALID_FLOW_NAME',
          message: `flow name '${name}' is invalid — must match [A-Za-z0-9_-]{1,128}`,
        });
        continue;
      }
      if (typeof value !== 'string' || value === '') {
        errors.push({
          code: 'MANIFEST_INVALID_FLOW_PATH',
          message: `flow '${name}' must map to a non-empty flow.yaml path, got ${JSON.stringify(value)}`,
        });
        continue;
      }
      flows[name] = isAbsolute(value) ? value : resolve(manifestDir, value);
    }
  }

  const rawAlertChannel = doc['global_alert_channel'];
  if (rawAlertChannel !== undefined && (typeof rawAlertChannel !== 'string' || rawAlertChannel === '')) {
    errors.push({
      code: 'MANIFEST_INVALID_ALERT_CHANNEL',
      message: `global_alert_channel must be a non-empty string, got ${JSON.stringify(rawAlertChannel)}`,
    });
  }

  // The original listener-backpressure work: run backpressure cap. Validated, not trusted — a malformed cap
  // must never silently mean "unlimited".
  const rawMaxConcurrentRuns = doc['max_concurrent_runs'];
  if (
    rawMaxConcurrentRuns !== undefined &&
    (typeof rawMaxConcurrentRuns !== 'number' ||
      !Number.isInteger(rawMaxConcurrentRuns) ||
      rawMaxConcurrentRuns < 1)
  ) {
    errors.push({
      code: 'MANIFEST_INVALID_MAX_CONCURRENT_RUNS',
      message: `max_concurrent_runs must be a positive integer, got ${JSON.stringify(rawMaxConcurrentRuns)}`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    manifest: {
      flows,
      ...(typeof rawAlertChannel === 'string' && { globalAlertChannel: rawAlertChannel }),
      ...(typeof rawMaxConcurrentRuns === 'number' && { maxConcurrentRuns: rawMaxConcurrentRuns }),
    },
  };
}
