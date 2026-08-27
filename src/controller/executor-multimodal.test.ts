/**
 * Integration tests: image inputs wired through the executor to the model call
 * and the checkpoint binding stamp (WI-419, FR-2 / FR-4 / FR-5 / NFR-1 / NFR-2).
 *
 * This is the integration item that ties together:
 *   - WI-413  loadImageInput + ModelCall.images        (src/worker/image-input.ts)
 *   - WI-414  StationConfig.image_inputs declaration   (src/flow/load.ts)
 *   - WI-415  multimodal adapter request shape         (src/worker/openai-adapter.ts)
 *   - WI-417  hashImageInputs binding-stamp helper      (src/worker/image-input.ts)
 *
 * These drive the REAL runExecutor over a minimal flow loaded by the real loader,
 * with an in-memory DB and a stub ModelAdapter (no network). The transform
 * station declares `image_inputs`; the executor must (a) load each declared image
 * and attach it to the station's ModelCall so the stub adapter observes it, (b)
 * fold the image bytes into the station's binding stamp alongside text-input
 * hashes, and (c) leave a no-image station's call + stamp identical to today.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/controller/executor.ts (executeTransformStation)
 * ---------------------------------------------------------------------------
 *   - For each entry in stationConfig.image_inputs, the executor calls
 *     loadImageInput(projectRoot, entry.path) and passes the resulting ImageInput[]
 *     through TransformContext → runTransformStation → ModelCall.images (AC1/AC2).
 *   - hashImageInputs(images) is folded into the binding-stamp inputArtifactHashes
 *     BEFORE computeBindingStamp, so a changed image invalidates the checkpoint and
 *     an unchanged image permits skip-on-resume (AC3).
 *   - Only DECLARED images are loaded; an undeclared image under project_root is
 *     never opened (AC4 / NFR-2).
 *   - A station with no image_inputs produces a ModelCall with no images attached
 *     and the same binding stamp as today (AC5 / NFR-1).
 *   - A declared image whose file is missing/unreadable surfaces the WI-413 loader
 *     error (names the path, not a raw ENOENT) — the same clear-error failure path
 *     as a missing text input, which propagates out of runExecutor (AC6 / FR-7).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// Stub adapter — single (transform worker) model; records every ModelCall so a
// test can inspect the images attached to the station's call. No network.
// ---------------------------------------------------------------------------

const WORKER_MODEL = 'gpt-4o';

function makeCaptionAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return {
        text: JSON.stringify({ caption: 'a description' }),
        inputTokens: 5,
        outputTokens: 3,
        costUsd: 0.001,
      };
    },
  };
  return { adapter, calls };
}

function workerCalls(calls: ModelCall[]): ModelCall[] {
  return calls.filter((c) => c.model === WORKER_MODEL);
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Image fixture bytes.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_JFIF = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00];

function pngBytesWithMarker(marker: string): Uint8Array {
  const markerBytes = new TextEncoder().encode(marker);
  const out = new Uint8Array(PNG_SIGNATURE.length + markerBytes.length);
  out.set(PNG_SIGNATURE, 0);
  out.set(markerBytes, PNG_SIGNATURE.length);
  return out;
}

// ---------------------------------------------------------------------------
// DB + card helpers.
// ---------------------------------------------------------------------------

function openDb(): ConduitDB {
  const handle = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(handle.getStateDb());
  return handle;
}

function seedCard(handle: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  handle.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: over.parent_id ?? null,
    lane: over.lane,
    status: over.status ?? 'ready',
    attempt: over.attempt ?? 0,
    wave: over.wave ?? 0,
    owned_paths: over.owned_paths ?? ['caption.json'],
    rework_count: over.rework_count ?? 0,
  });
}

function checkpointStamps(handle: ConduitDB, station: string): string[] {
  return (
    handle
      .getStateDb()
      .prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s')
      .all({ $s: station }) as Array<{ binding_stamp: string }>
  ).map((r) => r.binding_stamp);
}

// ---------------------------------------------------------------------------
// Flow fixture — one transform station that may declare text inputs and/or image
// inputs. next: done, no gate (keeps the dispatch focused on the worker call).
// ---------------------------------------------------------------------------

interface CaptionFlowOpts {
  textInputs?: string[];
  imageInputs?: string[];
  workerPrompt?: string;
  /** Mark the caption station effectful (engages the outbox discipline). */
  effectful?: boolean;
  /** Declare a per-station wall-clock timeout (punch-list #8). */
  timeoutSeconds?: number;
}

function setupCaptionFlow(dir: string, opts: CaptionFlowOpts = {}): FlowConfig {
  const textInputs = opts.textInputs ?? [];
  const imageInputs = opts.imageInputs ?? [];
  const workerPrompt = opts.workerPrompt ?? 'Describe the attached image.';

  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'caption.md'), workerPrompt);
  for (const t of textInputs) {
    writeFileSync(join(dir, t), '{"ctx":"CTXDATA"}');
  }

  const inputsYaml = `[${textInputs.join(', ')}]`;
  const imageYaml =
    imageInputs.length > 0
      ? `\n    image_inputs: [${imageInputs.map((p) => `{ path: ${p} }`).join(', ')}]`
      : '';

  const flowYaml = `
flow: executor-mm
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: caption
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/caption.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: caption, type: string, required: true }${opts.timeoutSeconds !== undefined ? `\n      timeout_seconds: ${opts.timeoutSeconds}` : ''}${opts.effectful ? '\n    effectful: true' : ''}
    inputs: ${inputsYaml}${imageYaml}
    outputs: [caption.json]
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

// ---------------------------------------------------------------------------
// Lifecycle — each test in its own temp project dir (chdir for project_root '.').
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-mm-exec-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

function writeImageFile(rel: string, bytes: Uint8Array): void {
  const abs = join(projectDir, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, Buffer.from(bytes));
}

/** Run the caption flow once for `imageBytes` in a fresh DB; return the station's stamp. */
async function runAndGetStamp(imageBytes: Uint8Array): Promise<string> {
  writeImageFile('assets/frame.png', imageBytes);
  const flow = setupCaptionFlow(projectDir, { imageInputs: ['assets/frame.png'] });
  const localDb = openDb();
  try {
    seedCard(localDb, { id: 'c', lane: 'caption' });
    const { adapter } = makeCaptionAdapter();
    const { io } = makeIO();
    await runExecutor({ db: localDb, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    const stamps = checkpointStamps(localDb, 'caption');
    if (stamps.length === 0) throw new Error('no checkpoint stamp was written for the caption station');
    return stamps[0]!;
  } finally {
    localDb.close();
  }
}

// ===========================================================================
// AC1 — declared image inputs are loaded and reach the adapter call.
// ===========================================================================

describe('executor — declared image inputs reach the model call (AC1)', () => {
  it('loads a single declared image and attaches it to the station ModelCall', async () => {
    const bytes = pngBytesWithMarker('FRAME_A');
    writeImageFile('assets/frame.png', bytes);
    const flow = setupCaptionFlow(projectDir, { imageInputs: ['assets/frame.png'] });
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption' });
    const { adapter, calls } = makeCaptionAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    const wc = workerCalls(calls);
    expect(wc).toHaveLength(1);
    const images = wc[0]!.images;
    expect(images).toBeDefined();
    expect(images).toHaveLength(1);
    expect(images![0]!.mediaType).toBe('image/png');
    expect(Buffer.from(images![0]!.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it('attaches multiple declared images in declared order, each with its media type', async () => {
    writeImageFile('assets/a.png', pngBytesWithMarker('A'));
    writeImageFile('assets/b.jpg', Uint8Array.from(JPEG_JFIF));
    const flow = setupCaptionFlow(projectDir, { imageInputs: ['assets/a.png', 'assets/b.jpg'] });
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption' });
    const { adapter, calls } = makeCaptionAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const images = workerCalls(calls)[0]!.images;
    expect(images).toHaveLength(2);
    expect(images![0]!.mediaType).toBe('image/png');
    expect(images![1]!.mediaType).toBe('image/jpeg');
  });
});

// ===========================================================================
// AC2 — mixed text + image: text renders into the prompt AND images attach in
//        the same call.
// ===========================================================================

describe('executor — mixed text + image inputs on one station (AC2)', () => {
  it('renders text inputs into the prompt and attaches images in the same call', async () => {
    writeImageFile('assets/frame.png', pngBytesWithMarker('FRAME_MIX'));
    const flow = setupCaptionFlow(projectDir, {
      textInputs: ['context.json'],
      imageInputs: ['assets/frame.png'],
      workerPrompt: 'Caption using {{context.json}}',
    });
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption', owned_paths: ['caption.json'] });
    const { adapter, calls } = makeCaptionAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const wc = workerCalls(calls)[0]!;
    // Text input rendered into the prompt (renderPrompt unchanged) ...
    expect(wc.prompt).toContain('Caption using');
    expect(wc.prompt).toContain('CTXDATA');
    // ... AND the image is attached on the same call.
    expect(wc.images).toHaveLength(1);
  });
});

// ===========================================================================
// AC3 — image bytes are folded into the binding stamp: a changed image yields a
//        different stamp (re-run), an unchanged image yields an identical stamp
//        (skip-on-resume). Both directions verified against the executor path.
// ===========================================================================

describe('executor — image bytes participate in the binding stamp (AC3)', () => {
  it('a changed image input produces a DIFFERENT binding stamp (checkpoint invalidated → re-run)', async () => {
    const stampA = await runAndGetStamp(pngBytesWithMarker('IMAGE_VERSION_A'));
    const stampB = await runAndGetStamp(pngBytesWithMarker('IMAGE_VERSION_B_DIFFERENT'));
    // Everything else (text inputs, model, prompt version, flow version) is held
    // constant — so a differing stamp proves the image bytes are folded in.
    expect(stampA).not.toBe(stampB);
  });

  it('an UNCHANGED image input produces an IDENTICAL binding stamp (skip-on-resume permitted)', async () => {
    const bytes = pngBytesWithMarker('IMAGE_STABLE');
    const stamp1 = await runAndGetStamp(bytes);
    const stamp2 = await runAndGetStamp(bytes);
    expect(stamp1).toBe(stamp2);
  });
});

// ===========================================================================
// AC4 — only DECLARED images are loaded; an undeclared image under project_root
//        is never attached/opened (NFR-2 input-scope discipline).
// ===========================================================================

describe('executor — only declared images are read (AC4 / NFR-2)', () => {
  it('attaches only the declared image, never an undeclared sibling under project_root', async () => {
    writeImageFile('assets/declared.png', pngBytesWithMarker('DECLARED'));
    writeImageFile('assets/secret.png', pngBytesWithMarker('SECRET')); // present but NOT declared
    const flow = setupCaptionFlow(projectDir, { imageInputs: ['assets/declared.png'] });
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption' });
    const { adapter, calls } = makeCaptionAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const images = workerCalls(calls)[0]!.images;
    expect(images).toHaveLength(1);
    expect(images![0]!.path).toContain('declared.png');
    expect(images!.some((img) => img.path.includes('secret.png'))).toBe(false);
  });
});

// ===========================================================================
// AC5 — a station with no declared image inputs is unchanged (NFR-1): the call
//        carries no images.
// ===========================================================================

describe('executor — text-only stations are unaffected (AC5 / NFR-1)', () => {
  it('produces a ModelCall with no images attached when no image inputs are declared', async () => {
    const flow = setupCaptionFlow(projectDir, {
      textInputs: ['context.json'],
      workerPrompt: 'Caption using {{context.json}}',
    });
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption', owned_paths: ['caption.json'] });
    const { adapter, calls } = makeCaptionAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    const wc = workerCalls(calls)[0]!;
    expect(wc.images).toBeUndefined();
  });
});

// ===========================================================================
// AC6 — a declared image whose file is missing surfaces the WI-413 loader error
//        (names the path, not a raw ENOENT) — same failure path as a missing
//        text input, which propagates out of runExecutor (FR-7).
// ===========================================================================

describe('executor — missing declared image fails loudly (AC6 / FR-7)', () => {
  it('rejects with a clear, path-naming error (never a raw ENOENT) when a declared image is missing', async () => {
    // The image is DECLARED but never written to disk.
    const flow = setupCaptionFlow(projectDir, { imageInputs: ['assets/missing.png'] });
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption' });
    const { adapter } = makeCaptionAdapter();
    const { io } = makeIO();

    let message = '';
    try {
      await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('missing.png'); // names the offending path (FR-7)
    expect(message).not.toMatch(/ENOENT/); // clear error, not a raw ENOENT
  });
});

// ===========================================================================
// Code-review fix #1 — an EFFECTFUL transform station that fast-scraps on a
// vision-unsupported classification must abandon the PENDING outbox intent it
// wrote before the call. A leftover pending row would make a later replay of the
// scrapped attempt escalate_hold on an effect that never landed.
// ===========================================================================

function visionUnsupportedAdapter(): ModelAdapter {
  return {
    async call(): Promise<ModelResponse> {
      const err = new Error('This model does not support image inputs') as Error & { code?: string };
      err.code = 'vision-unsupported';
      throw err;
    },
  };
}

function pendingOutboxKeys(handle: ConduitDB): string[] {
  return (
    handle
      .getStateDb()
      .prepare('SELECT idempotency_key FROM outbox WHERE delivered_at IS NULL')
      .all() as Array<{ idempotency_key: string }>
  ).map((r) => r.idempotency_key);
}

describe('executor — effectful + vision-unsupported leaves no dangling outbox intent (fix #1)', () => {
  it('scraps the card AND clears the pending intent (no escalate_hold on replay)', async () => {
    const flow = setupCaptionFlow(projectDir, { imageInputs: ['assets/k.png'], effectful: true });
    writeImageFile('assets/k.png', pngBytesWithMarker('VISION_SCRAP'));
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption' });
    const { io } = makeIO();

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: visionUnsupportedAdapter(),
      io,
    } as RunEngineArgs);

    // The card lands in scrap (non-retryable capability mismatch)...
    const card = db.getCard(DEFAULT_RUN_ID, 'c1');
    expect(card?.lane).toBe('scrap');
    // ...and the PENDING intent written before the call is gone, not dangling.
    expect(pendingOutboxKeys(db)).toEqual([]);
  });
});

// ===========================================================================
// Punch-list #8 — a transform station's timeout_seconds reaches the model call
// as timeoutMs (seconds → ms), so the adapter can bound a hung gateway call.
// ===========================================================================

describe('executor — transform timeout_seconds threads to the model call (fix #8)', () => {
  it('passes timeout_seconds * 1000 as ModelCall.timeoutMs', async () => {
    const flow = setupCaptionFlow(projectDir, { textInputs: ['brief.json'], timeoutSeconds: 30 });
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption' });
    const { adapter, calls } = makeCaptionAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const worker = workerCalls(calls);
    expect(worker).toHaveLength(1);
    expect(worker[0].timeoutMs).toBe(30_000);
  });

  it('omits timeoutMs when the station declares no timeout (unbounded)', async () => {
    const flow = setupCaptionFlow(projectDir, { textInputs: ['brief.json'] });
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption' });
    const { adapter, calls } = makeCaptionAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect('timeoutMs' in workerCalls(calls)[0]).toBe(false);
  });
});
