/**
 * WI-439 — docker-compose.dev.yml: dev-iteration stack
 * (engine + project bind-mount + model sidecar + named state volume).
 *
 * The compose file (impl) is the artifact under test; it doubles as living docs
 * of the dev topology. The deliverable is the file's parsed structure plus its
 * validity as a compose file, so:
 *
 *   - TOPOLOGY assertions parse the YAML (via the `yaml` dep already in
 *     package.json) and assert the documented services/volumes/env wiring. They
 *     run UNCONDITIONALLY — no docker required.
 *
 *   - The `docker compose config` validity assertion is gated behind a
 *     compose-availability check (`describe.skipIf(!composeAvailable)`); when
 *     compose is absent it is reported SKIPPED, not silently passed.
 *
 * Wiring facts derived from src/cli/main.ts:
 *   - The model-endpoint env var is CONDUIT_BASE_URL (the `gateway_base_url`
 *     doctor probe reads process.env.CONDUIT_BASE_URL). FR-9: the model is a
 *     sidecar service the engine reaches via that var, never baked in.
 *   - DEFAULT_STATE_DB is /data/conduit.sqlite (FR-6) → the named state volume
 *     mounts at /data.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

// ---------------------------------------------------------------------------
// Paths & capability probe
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const COMPOSE_PATH = join(REPO_ROOT, 'docker-compose.dev.yml');

function commandSucceeds(argv: string[]): boolean {
  try {
    return Bun.spawnSync(argv, { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  } catch {
    return false;
  }
}

const composeAvailable = commandSucceeds(['docker', 'compose', 'version']);

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface ComposeFile {
  services?: Record<string, ServiceDef>;
  volumes?: Record<string, unknown>;
}
interface ServiceDef {
  image?: string;
  build?: unknown;
  environment?: Record<string, unknown> | string[];
  env_file?: string | string[];
  volumes?: Array<string | { type?: string; source?: string; target?: string }>;
}
interface VolumeMount {
  source?: string;
  target: string;
  type?: string;
}

function rawCompose(): string {
  // RED phase (no file yet): ENOENT → tests fail for the right reason.
  return readFileSync(COMPOSE_PATH, 'utf-8');
}

function loadCompose(): ComposeFile {
  return parse(rawCompose()) as ComposeFile;
}

function parseEnv(svc: ServiceDef | undefined): Record<string, string | null> {
  const env = svc?.environment;
  const out: Record<string, string | null> = {};
  if (!env) return out;
  if (Array.isArray(env)) {
    for (const entry of env) {
      const s = String(entry);
      const eq = s.indexOf('=');
      if (eq === -1) out[s] = null;
      else out[s.slice(0, eq)] = s.slice(eq + 1);
    }
  } else {
    for (const [k, v] of Object.entries(env)) out[k] = v === null ? null : String(v);
  }
  return out;
}

function parseVolumes(svc: ServiceDef | undefined): VolumeMount[] {
  const vols = svc?.volumes;
  if (!Array.isArray(vols)) return [];
  return vols.map((v) => {
    if (typeof v === 'string') {
      const parts = v.split(':');
      if (parts.length === 1) return { target: parts[0]! };
      return { source: parts[0], target: parts[1]! };
    }
    return { source: v.source, target: v.target ?? '', type: v.type };
  });
}

function isPathSource(src?: string): boolean {
  return !!src && (src.includes('/') || src.startsWith('.') || src.startsWith('$') || src.startsWith('~'));
}

/** A bind mount whose source is the project root (`.`, `./`, `$PWD`/`${PWD}`). */
function isProjectRootBind(v: VolumeMount): boolean {
  const s = v.source;
  if (!s) return false;
  return s === '.' || s === './' || /^\$\{?PWD\}?\/?$/.test(s);
}

/** A managed (named) volume reference — a bare identifier, not a host path. */
function isNamedVolumeSource(src?: string): boolean {
  return !!src && !isPathSource(src) && /^[A-Za-z0-9][\w.-]*$/.test(src);
}

function findEngineService(compose: ComposeFile): [string | undefined, ServiceDef | undefined] {
  for (const [name, svc] of Object.entries(compose.services ?? {})) {
    if (typeof svc?.image === 'string' && svc.image.includes('conduit-engine')) return [name, svc];
  }
  return [undefined, undefined];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return new URL('http://' + url).hostname;
  }
}

const SECRET_ENV_KEYS = [
  'CONDUIT_API_KEY',
  'OPENAI_API_KEY',
  'SLACK_BOT_TOKEN',
  'CONDUIT_SLACK_SIGNING_SECRET',
];

// ===========================================================================
// TOPOLOGY — unconditional (parse only, no docker)
// ===========================================================================

describe('docker-compose.dev.yml — topology (static, unconditional)', () => {
  it('parses as YAML and declares services and a named volume (AC1)', () => {
    const compose = loadCompose();
    expect(compose.services).toBeDefined();
    expect(Object.keys(compose.services ?? {}).length).toBeGreaterThanOrEqual(2);
    // FR-6 named state volume must be declared at the top level.
    expect(compose.volumes).toBeDefined();
    expect(Object.keys(compose.volumes ?? {}).length).toBeGreaterThanOrEqual(1);
  });

  it('engine service uses the conduit-engine image (AC2)', () => {
    const [name, engine] = findEngineService(loadCompose());
    expect(name).toBeDefined();
    expect(engine!.image).toContain('conduit-engine');
  });

  it('engine bind-mounts the project root for edit-and-re-run (AC2, FR-12a)', () => {
    const [, engine] = findEngineService(loadCompose());
    expect(engine).toBeDefined();
    const mounts = parseVolumes(engine);
    const projectBind = mounts.find(isProjectRootBind);
    expect(projectBind).toBeDefined();
    // Mounted at an absolute container path (the workdir source lives at).
    expect(projectBind!.target.startsWith('/')).toBe(true);
  });

  it('declares a model sidecar referenced by the engine via CONDUIT_BASE_URL (AC3, FR-9)', () => {
    const compose = loadCompose();
    const [engineName, engine] = findEngineService(compose);
    expect(engineName).toBeDefined();

    const baseUrl = parseEnv(engine)['CONDUIT_BASE_URL'];
    expect(typeof baseUrl).toBe('string');
    expect(baseUrl!.length).toBeGreaterThan(0);

    // The endpoint host must name another declared service — the model sidecar.
    const sidecarName = hostOf(baseUrl!);
    expect(sidecarName).not.toBe(engineName);
    expect(Object.keys(compose.services ?? {})).toContain(sidecarName);
    expect(compose.services![sidecarName]).toBeDefined();
  });

  it('persists conduit state on a named volume mounted at /data (AC4, FR-6)', () => {
    const compose = loadCompose();
    const [, engine] = findEngineService(compose);
    expect(engine).toBeDefined();

    const dataMount = parseVolumes(engine).find((m) => m.target === '/data');
    expect(dataMount).toBeDefined();
    const source = dataMount!.source ?? '';
    // Not the ephemeral FS or a bind — a managed named volume...
    expect(isNamedVolumeSource(source)).toBe(true);
    // ...that is declared in the top-level volumes section.
    expect(Object.keys(compose.volumes ?? {})).toContain(source);
  });

  it('hard-codes no secret values (AC5, FR-5)', () => {
    const raw = rawCompose();
    const compose = loadCompose();

    // No raw secret tokens anywhere in the file.
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(raw).not.toMatch(/xox[baprs]-[A-Za-z0-9-]+/);

    // Secret-named env values must be interpolated (${VAR}/$VAR) or empty —
    // never a baked literal.
    for (const svc of Object.values(compose.services ?? {})) {
      const env = parseEnv(svc);
      for (const key of SECRET_ENV_KEYS) {
        if (!(key in env)) continue;
        const value = env[key];
        if (value === null || value === '') continue; // passthrough / empty is fine
        expect(value.startsWith('$')).toBe(true);
      }
      // Any env_file must be a .env-style file (covered by .gitignore's .env/.env.*).
      const envFiles = svc?.env_file;
      const list = Array.isArray(envFiles) ? envFiles : envFiles ? [envFiles] : [];
      for (const f of list) {
        expect(String(f)).toMatch(/\.env(\.|$)/);
      }
    }
  });
});

// ===========================================================================
// COMPOSE VALIDATION — docker-gated
// ===========================================================================

describe.skipIf(!composeAvailable)('docker-compose.dev.yml — compose validation (docker-gated)', () => {
  it('docker compose config validates the file (AC1)', () => {
    const r = Bun.spawnSync(['docker', 'compose', '-f', COMPOSE_PATH, 'config', '-q'], {
      cwd: REPO_ROOT,
    });
    if (r.exitCode !== 0) {
      console.error(`docker compose config failed:\n${r.stderr ? r.stderr.toString().slice(-800) : ''}`);
    }
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
