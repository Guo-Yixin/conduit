/**
 * Worker subprocess entry — the out-of-process side of the pool (SPEC §10A).
 *
 * The controller spawns one of these PER dispatched card (the makeWorkerPool
 * seam), passing the flow path + project root on argv. The worker:
 *   1. loads + validates the flow ONCE at startup (config validated, not trusted);
 *   2. waits for a single START_WORK over Bun IPC;
 *   3. runs the (plain, pure) deterministic station body via the worker harness;
 *   4. reports exactly one MARK_DONE, then self-exits.
 *
 * NFR-3: NO state-DB import and NO DB I/O — the kernel is the SOLE writer. All
 * results flow over IPC. NFR-4: MARK_DONE carries an outcome + token counts only,
 * never artifact bytes (artifacts land on disk under owned_paths).
 *
 * The controller only ever routes PLAIN PURE deterministic stations here
 * (transform/agentic/fan-out/effectful/enforce_owned_paths stations stay on the
 * in-process path), so this runner deliberately handles only that case.
 */

import { loadFlow } from '../flow/load';
import type { LoadFlowResult } from '../flow/load';
import { buildHarnessDefinitionRegistry, bindHarnessDefinitions } from './harness-adapter';
import { parseHarnessConfig } from './harness-config';
import { runDeterministic, deterministicCardEnv } from './deterministic';
import { handleStartWork } from './harness';
import type { HarnessTimers, StationRunResult } from './harness';
import { parseWorkerMessage, serializeWorkerMessage, sanitizeStderrTail } from './ipc-protocol';
import type { StartWorkMessage, WorkerMessage } from './ipc-protocol';
import type { FlowConfig } from '../types/kernel';

/** Injected I/O seams so the worker loop is unit-testable without a real subprocess. */
export interface WorkerProcessIO {
  /** Register the inbound-IPC handler (raw payloads from the controller). */
  onMessage: (handler: (raw: unknown) => void) => void;
  /** Send a serialized message back to the controller. */
  send: (raw: string) => void;
  /** Diagnostics channel (stderr in production — never stdout, which is IPC-adjacent). */
  err: (line: string) => void;
  /** Heartbeat timer seam (real timers in production). */
  timers: HarnessTimers;
  /** Self-terminate after the one task completes (process.exit in production). */
  exit: (code: number) => void;
}

export interface WorkerProcessConfig {
  flowPath: string;
  projectRoot: string;
}

/**
 * Build the deterministic station runner for a loaded flow. The allowlist is the
 * union of every declared deterministic command — identical to how the executor
 * derives its runtime allowlist, so the worker enforces the same Law-lite gate.
 */
function makeRunStation(
  flow: FlowConfig,
  projectRoot: string,
  err: (line: string) => void,
): (start: StartWorkMessage) => Promise<StationRunResult> {
  const allowlist: string[] = [];
  for (const s of Object.values(flow.stations)) {
    if (s.kind === 'deterministic' && s.command) allowlist.push(s.command);
  }

  return async (start: StartWorkMessage): Promise<StationRunResult> => {
    const station = flow.stations[start.station];
    if (!station || station.kind !== 'deterministic' || !station.command) {
      // The controller should never route a non-deterministic station here; if
      // it does, fail closed with a scrap rather than silently no-op.
      err(`worker: station '${start.station}' is not a runnable deterministic station`);
      return { outcome: 'scrap', attempt: start.attempt };
    }

    const timeoutMs =
      station.timeout_seconds !== undefined ? station.timeout_seconds * 1000 : undefined;

    // Inject the same per-card env the synchronous path builds (PATCH 2), sourced
    // from START_WORK. Without this a pool-eligible (plain pure) deterministic
    // station would see CONDUIT_REWORK_COUNT/CONDUIT_ATTEMPT only at concurrency=1
    // and get empty strings under `--concurrency K>1`. reworkCount is optional on
    // the message → coalesce to 0.
    const result = await runDeterministic(
      { command: station.command, args: station.args ?? [] },
      {
        allowlist,
        cwd: projectRoot,
        timeoutMs,
        env: deterministicCardEnv(start.reworkCount ?? 0, start.attempt),
      },
    );

    // exit 0 → success. Any failure (nonzero exit or timeout) → 'failed' with
    // diagnostic detail (the original deterministic failure-reporting work / the pre-public deterministic failure-reporting review): the KERNEL applies the
    // attempt-cap accounting — retry below per_card.max_execution_attempts,
    // named scrap at it — exactly as the synchronous path does, so the same
    // flaky command behaves identically at concurrency=1 and K>1. The worker
    // never decides terminality for a command failure; it only reports.
    // ('scrap' remains the worker's verdict for routing errors above, where a
    // retry genuinely cannot help.)
    if (!result.ok) {
      // Sanitized (control chars stripped) + sliced to the codec cap — the tail
      // lands in kernel reason strings and journal rows, never raw.
      const stderrTail = sanitizeStderrTail(result.stderr);
      return {
        outcome: 'failed',
        attempt: start.attempt,
        usage: { tokens: 0 },
        failure: {
          exitCode: result.exitCode,
          ...(result.timedOut !== undefined && { timedOut: result.timedOut }),
          ...(stderrTail.length > 0 && { stderrTail }),
        },
      };
    }
    return {
      outcome: 'success',
      attempt: start.attempt,
      // Deterministic stations never call the model, so spend is zero. The field
      // is carried explicitly so the kernel's token attribution is uniform across
      // the pool (a future transform-capable worker reports real spend here).
      usage: { tokens: 0 },
    };
  };
}

/**
 * Drive one worker subprocess: wire the IPC handler, run the single assigned
 * station, and self-exit once its MARK_DONE has been sent. Resolves when the
 * handler has been registered (the process then lives until `exit` is called).
 */
export function runWorkerProcess(config: WorkerProcessConfig, io: WorkerProcessIO): void {
  // WI-576/588: this subprocess cannot receive a live registry over argv/IPC,
  // so it constructs its own registry instance from the same config source
  // (the CONDUIT_HARNESS_* env, as main.ts's DI does), bound directly to this
  // worker's own projectRoot — no load-time placeholder needed since the real
  // root is already known here.
  // A malformed CONDUIT_HARNESS_* config (or an unshipped adapter name) is
  // treated as a load failure rather than an uncaught throw: the controller
  // already validates config at boot (buildProductionDeps), so reaching this
  // is a defensive backstop, not the common path.
  let loaded: LoadFlowResult;
  try {
    const parsedHarnessConfig = parseHarnessConfig(process.env);
    if (!parsedHarnessConfig.ok) {
      throw new Error(parsedHarnessConfig.error);
    }
    const harnessRegistry = bindHarnessDefinitions(
      buildHarnessDefinitionRegistry(parsedHarnessConfig.defs),
      config.projectRoot,
    );
    loaded = loadFlow(config.flowPath, { harnessRegistry });
  } catch (err) {
    loaded = {
      ok: false,
      errors: [
        {
          code: 'HARNESS_CONFIG_INVALID',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  // Flow failed to load: we cannot run any station. Reply 'scrap' to whatever
  // START_WORK arrives so the controller advances the card to a terminal lane
  // instead of waiting out the lease, then exit. (The controller validates the
  // flow before spawning, so this is a defensive backstop, not the common path.)
  if (!loaded.ok) {
    io.err(
      `worker: failed to load flow '${config.flowPath}': ` +
        loaded.errors.map((e) => e.message).join('; '),
    );
    io.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      const parsed = parseWorkerMessage(raw);
      if (!parsed.ok || parsed.message.type !== 'START_WORK') return;
      const m = parsed.message;
      io.send(
        serializeWorkerMessage({
          type: 'MARK_DONE',
          cardId: m.cardId,
          station: m.station,
          attempt: m.attempt,
          outcome: 'scrap',
        }),
      );
      io.exit(0);
    });
    return;
  }

  const runStation = makeRunStation(loaded.flow, config.projectRoot, io.err);

  io.onMessage((raw) => {
    if (typeof raw !== 'string') {
      io.err('worker: ignoring non-string IPC payload');
      return;
    }
    const parsed = parseWorkerMessage(raw);
    if (!parsed.ok) {
      io.err(`worker: rejected IPC message: ${parsed.error}`);
      return;
    }
    // Workers only ever receive START_WORK; ignore anything else defensively.
    if (parsed.message.type !== 'START_WORK') return;

    const start = parsed.message;
    // handleStartWork never throws — a body that throws becomes a scrap MARK_DONE.
    void handleStartWork(start, {
      runStation,
      send: (msg: WorkerMessage) => {
        io.send(serializeWorkerMessage(msg));
        if (msg.type === 'MARK_DONE') {
          // One-shot: this worker handled its single assigned card. Exit so the
          // process is reaped immediately (Bun flushes the IPC send before exit).
          io.exit(0);
        }
      },
      timers: io.timers,
    });
  });
}

/**
 * Production entry: wire `runWorkerProcess` to the real Bun process IPC + timers.
 * Invoked by the `__worker <flowPath> <projectRoot>` CLI subcommand.
 */
export function startWorkerMain(argv: string[]): void {
  const flowPath = argv[0];
  const projectRoot = argv[1];
  if (!flowPath || !projectRoot) {
    process.stderr.write('worker: usage: __worker <flowPath> <projectRoot>\n');
    process.exit(1);
    return;
  }

  runWorkerProcess(
    { flowPath, projectRoot },
    {
      onMessage: (handler) => {
        process.on('message', handler);
      },
      send: (raw) => {
        // process.send exists only when spawned with an IPC channel.
        process.send?.(raw);
      },
      err: (line) => process.stderr.write(line + '\n'),
      timers: {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      },
      exit: (code) => process.exit(code),
    },
  );
}
