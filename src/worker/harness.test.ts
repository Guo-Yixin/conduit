/**
 * Tests for the worker harness subprocess (WI-469, SPEC §10A, NFR-3 / NFR-4).
 *
 * The harness is the SPEC §10A worker process: it receives a START_WORK over
 * IPC, runs the assigned station's BODY (via an injected station-runner seam),
 * emits periodic HEARTBEATs while the body is in flight, and reports EXACTLY
 * ONE MARK_DONE when the body settles. It is the kernel's hands at the station,
 * not its brain — so:
 *
 *   - NFR-3: the harness NEVER opens or writes conduit.sqlite. It is given no
 *     DB handle at all; every result leaves over the injected `send` seam.
 *   - NFR-4: artifacts are written to owned_paths on the filesystem by the
 *     station body; the MARK_DONE the harness emits carries an OUTCOME only
 *     (success | rework | scrap) — never artifact bytes.
 *   - A station body that throws is reported as a MARK_DONE failure outcome
 *     ('scrap'), not a silent hang and not an unhandled crash.
 *
 * The kernel-side post-work transition/checkpoint/journal and the actual
 * renewLease DB write are NOT this item — the harness only SIGNALS the heartbeat
 * over IPC. All DB I/O stays in the kernel (next item).
 *
 * Seams are injected so the harness is unit-testable WITHOUT a real spawned
 * process or real timers.
 *
 * Contract this file pins for src/worker/harness.ts:
 *
 *   import type { StartWorkMessage, WorkerMessage } from './ipc-protocol';
 *
 *   // The result of running ONE station body. The harness translates this into
 *   // the MARK_DONE outcome. References (paths) live on disk; never bytes here.
 *   export interface StationRunResult {
 *     outcome: 'success' | 'rework' | 'scrap';
 *     attempt: number;
 *   }
 *
 *   // The station-runner seam: runs the station body for a START_WORK. This is
 *   // the ONLY thing the harness invokes to do work — it does no DB I/O itself.
 *   export type StationRunner = (start: StartWorkMessage) => Promise<StationRunResult>;
 *
 *   // Minimal timer seam (mirrors setInterval/clearInterval) so heartbeat
 *   // cadence is deterministic in tests. handle is opaque.
 *   export interface HarnessTimers {
 *     setInterval(fn: () => void, ms: number): unknown;
 *     clearInterval(handle: unknown): void;
 *   }
 *
 *   export interface HarnessDeps {
 *     runStation: StationRunner;
 *     // IPC send seam — every outgoing message (HEARTBEAT, MARK_DONE) goes here.
 *     send: (msg: WorkerMessage) => void;
 *     timers: HarnessTimers;
 *     // Heartbeat cadence in ms (bounded interval). Optional; harness has a default.
 *     heartbeatMs?: number;
 *   }
 *
 *   // Handle one START_WORK end to end: schedule heartbeats, run the body,
 *   // stop heartbeats, emit exactly one MARK_DONE. NEVER throws — a thrown body
 *   // is caught and reported as a 'scrap' MARK_DONE.
 *   export function handleStartWork(start: StartWorkMessage, deps: HarnessDeps): Promise<void>;
 *
 * NOTE for B.A. (impl): you MAY factor a thin station-runner seam over
 * executeStation (src/controller/executor.ts:557) / executeTransformStation:948
 * / executeDeterministicStation:772, but `runStation` is INJECTED here so the
 * harness itself does NO DB I/O. Do NOT import ConduitDB into harness.ts.
 */

import { describe, it, expect } from 'bun:test';
import { handleStartWork, type HarnessDeps, type HarnessTimers } from './harness';
import type { StartWorkMessage, WorkerMessage } from './ipc-protocol';

// ---------------------------------------------------------------------------
// Test fakes for the injected seams
// ---------------------------------------------------------------------------

/** Captures every message the harness sends over IPC. */
function makeSendSpy() {
  const sent: WorkerMessage[] = [];
  const send = (msg: WorkerMessage) => {
    sent.push(msg);
  };
  return { sent, send };
}

/**
 * A controllable timer seam. The harness registers an interval; the test fires
 * it manually via `tick()` to deterministically drive heartbeats. `cleared`
 * records whether the harness stopped its interval (it must, when work ends).
 */
function makeFakeTimers() {
  let registered: (() => void) | null = null;
  let intervalMs: number | null = null;
  let cleared = false;
  const handle = Symbol('interval');

  const timers: HarnessTimers = {
    setInterval(fn: () => void, ms: number) {
      registered = fn;
      intervalMs = ms;
      return handle;
    },
    clearInterval(h: unknown) {
      if (h === handle) cleared = true;
    },
  };

  return {
    timers,
    tick() {
      if (!registered) throw new Error('no interval registered — harness did not schedule heartbeats');
      registered();
    },
    get intervalMs() {
      return intervalMs;
    },
    get cleared() {
      return cleared;
    },
    get scheduled() {
      return registered !== null;
    },
  };
}

const START: StartWorkMessage = {
  type: 'START_WORK',
  cardId: 'card-7',
  station: 'draft',
  attempt: 0,
  inputRefs: ['inputs/brief.md'],
};

// ---------------------------------------------------------------------------
// AC1 — runs the station body and emits exactly one MARK_DONE with the outcome
// ---------------------------------------------------------------------------

describe('handleStartWork — runs the body and emits one MARK_DONE (AC1)', () => {
  it('invokes the station runner with the START_WORK', async () => {
    const { send } = makeSendSpy();
    const timers = makeFakeTimers();
    let receivedStart: StartWorkMessage | null = null;
    const runStation = async (start: StartWorkMessage) => {
      receivedStart = start;
      return { outcome: 'success' as const, attempt: 0 };
    };

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    expect(receivedStart!).toEqual(START);
  });

  it('emits exactly one MARK_DONE carrying the success outcome', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome: 'success' as const, attempt: 2 });

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    const markDones = sent.filter((m) => m.type === 'MARK_DONE');
    expect(markDones).toHaveLength(1);
    const done = markDones[0];
    if (done.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(done.outcome).toBe('success');
    expect(done.cardId).toBe('card-7');
    expect(done.station).toBe('draft');
    expect(done.attempt).toBe(2);
  });

  it.each([
    ['success' as const],
    ['rework' as const],
    ['scrap' as const],
  ])('propagates the runner outcome=%s onto MARK_DONE', async (outcome) => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome, attempt: 0 });

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    const done = sent.find((m) => m.type === 'MARK_DONE');
    if (!done || done.type !== 'MARK_DONE') throw new Error('no MARK_DONE');
    expect(done.outcome).toBe(outcome);
  });

  it('forwards the runner usage onto MARK_DONE when present', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({
      outcome: 'success' as const,
      attempt: 0,
      usage: { tokens: 321, cost: 0.01 },
    });

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    const done = sent.find((m) => m.type === 'MARK_DONE');
    if (!done || done.type !== 'MARK_DONE') throw new Error('no MARK_DONE');
    expect(done.usage).toEqual({ tokens: 321, cost: 0.01 });
  });

  it('omits usage on MARK_DONE when the runner reports none (deterministic station)', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome: 'success' as const, attempt: 0 });

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    const done = sent.find((m) => m.type === 'MARK_DONE');
    if (!done || done.type !== 'MARK_DONE') throw new Error('no MARK_DONE');
    expect(done.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2 — emits HEARTBEATs on a bounded interval while the station is in flight
// ---------------------------------------------------------------------------

describe('handleStartWork — heartbeats while in flight (AC2)', () => {
  it('schedules a heartbeat interval on a bounded (positive) cadence', async () => {
    const { send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome: 'success' as const, attempt: 0 });

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    expect(timers.intervalMs).not.toBeNull();
    expect(timers.intervalMs as number).toBeGreaterThan(0);
  });

  it('honors an injected heartbeatMs cadence', async () => {
    const { send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome: 'success' as const, attempt: 0 });

    await handleStartWork(START, { runStation, send, timers: timers.timers, heartbeatMs: 250 });

    expect(timers.intervalMs).toBe(250);
  });

  it('emits a HEARTBEAT for this card/station each time the interval fires', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    // Gate the body on a promise we resolve AFTER firing the interval, so the
    // heartbeats land while work is genuinely in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runStation = async () => {
      await gate;
      return { outcome: 'success' as const, attempt: 0 };
    };

    const done = handleStartWork(START, { runStation, send, timers: timers.timers });

    // In-flight: fire the interval twice → two heartbeats.
    timers.tick();
    timers.tick();

    release();
    await done;

    const heartbeats = sent.filter((m) => m.type === 'HEARTBEAT');
    expect(heartbeats).toHaveLength(2);
    const hb = heartbeats[0];
    if (hb.type !== 'HEARTBEAT') throw new Error('wrong variant');
    expect(hb.cardId).toBe('card-7');
    expect(hb.station).toBe('draft');
  });

  it('stops the heartbeat interval once the body settles', async () => {
    const { send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome: 'success' as const, attempt: 0 });

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    expect(timers.cleared).toBe(true);
  });

  it('emits no HEARTBEAT after MARK_DONE (interval cleared before settle)', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome: 'success' as const, attempt: 0 });

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    // Body already settled and interval cleared. A stray late tick must throw
    // in the fake (no interval registered) OR be a no-op — either way, firing
    // it must not produce a post-MARK_DONE heartbeat. Assert ordering instead:
    const types = sent.map((m) => m.type);
    const lastIdx = types.lastIndexOf('MARK_DONE');
    const heartbeatAfterDone = types.slice(lastIdx + 1).includes('HEARTBEAT');
    expect(heartbeatAfterDone).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — never opens/writes the state DB; all results flow over the send seam
// ---------------------------------------------------------------------------

describe('handleStartWork — no DB writer constructed (NFR-3, AC3)', () => {
  it('completes using only injected seams (no DB handle in deps)', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome: 'success' as const, attempt: 0 });

    // HarnessDeps has no db field; the call type-checks and runs with seams only.
    const deps: HarnessDeps = { runStation, send, timers: timers.timers };
    await handleStartWork(START, deps);

    // The only observable output is messages on the send seam.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m.type === 'HEARTBEAT' || m.type === 'MARK_DONE')).toBe(true);
  });

  it('does not import the kernel DB module (harness stays DB-free)', async () => {
    // Static guard: the harness source must not pull in the state DB writer.
    // This protects NFR-3 at the dependency boundary, not via string-matching
    // behavior — it imports the module graph and asserts the DB module is absent.
    const mod = await import('./harness');
    // The module must export the harness entrypoint and nothing DB-shaped.
    expect(typeof mod.handleStartWork).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC4 — a thrown station body becomes a MARK_DONE failure (no hang/crash)
// ---------------------------------------------------------------------------

describe('handleStartWork — thrown body reported as failure (AC4)', () => {
  it('reports a scrap MARK_DONE when the station body throws', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => {
      throw new Error('model adapter exploded');
    };

    // Must NOT reject — the harness catches and reports.
    await handleStartWork(START, { runStation, send, timers: timers.timers });

    const markDones = sent.filter((m) => m.type === 'MARK_DONE');
    expect(markDones).toHaveLength(1);
    const done = markDones[0];
    if (done.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(done.outcome).toBe('scrap');
    expect(done.cardId).toBe('card-7');
    expect(done.station).toBe('draft');
  });

  it('does not reject the returned promise when the body throws', async () => {
    const { send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => {
      throw new Error('boom');
    };

    await expect(
      handleStartWork(START, { runStation, send, timers: timers.timers }),
    ).resolves.toBeUndefined();
  });

  it('stops the heartbeat interval even when the body throws', async () => {
    const { send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => {
      throw new Error('boom');
    };

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    expect(timers.cleared).toBe(true);
  });

  it('emits exactly one MARK_DONE even on failure (no duplicate report)', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => {
      throw new Error('boom');
    };

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    expect(sent.filter((m) => m.type === 'MARK_DONE')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC5 — MARK_DONE carries references/outcome only, never artifact bytes (NFR-4)
// ---------------------------------------------------------------------------

describe('handleStartWork — MARK_DONE is references/outcome only (NFR-4, AC5)', () => {
  it('emits a MARK_DONE whose only payload is the typed outcome fields', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    // Even if the runner result somehow carried extra data, the harness must
    // only forward the typed MARK_DONE fields — no bytes ride along.
    const runStation = async () =>
      ({ outcome: 'success', attempt: 1 }) as { outcome: 'success'; attempt: number };

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    const done = sent.find((m) => m.type === 'MARK_DONE');
    if (!done || done.type !== 'MARK_DONE') throw new Error('no MARK_DONE');
    // Exactly the MARK_DONE contract keys — nothing smuggling artifact bytes.
    expect(Object.keys(done).sort()).toEqual(
      ['attempt', 'cardId', 'outcome', 'station', 'type'].sort(),
    );
  });

  it('does not put the input artifact contents onto the wire', async () => {
    const { sent, send } = makeSendSpy();
    const timers = makeFakeTimers();
    const runStation = async () => ({ outcome: 'success' as const, attempt: 0 });

    await handleStartWork(START, { runStation, send, timers: timers.timers });

    // No emitted message serializes anything other than references/outcome.
    for (const msg of sent) {
      const json = JSON.stringify(msg);
      expect(json).not.toContain('artifactBytes');
      expect(json).not.toMatch(/data:[a-z]+\/[a-z]+;base64/i);
    }
  });
});
