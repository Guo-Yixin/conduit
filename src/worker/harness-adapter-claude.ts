/**
 * claude-headless harness adapter (WI-564).
 *
 * The first shipping real HarnessAdapter (WI-560). Builds a `claude -p`
 * invocation from engine config, spawns it through the bounded process runner
 * (WI-561) with the env allowlist (WI-562), parses the harness's STRUCTURED
 * JSON usage/cost output (never scraped from free text), and translates the
 * station's declared `tools` allowlist into claude's `--allowed-tools` flag.
 *
 * `outputs` is always `[]` — the executor collects declared outputs from disk
 * (findMissingDeclaredOutputs in executor.ts); the claude JSON payload carries
 * no file manifest, so this adapter never fabricates output references.
 *
 * Do NOT touch ./harness.ts (unrelated worker-pool subprocess harness).
 */

import type {
  HarnessAdapter, HarnessInvocation, HarnessResult, BinaryProbe,
  RateLimitSnapshot, RateLimitWindow,
} from './harness-adapter';
import { runHarnessProcess } from './harness-runner';
import type { HarnessCommand, HarnessRunnerConfig, HarnessSpawnResult } from './harness-runner';

export interface ClaudeHarnessAdapterConfig {
  /** Absolute project root threaded through to the process runner's cwd confinement. */
  projectRoot: string;
  /** Env var names visible to the child (NFR-Security-2), sourced from engine config. */
  envAllowlist: string[];
  /** Binary to invoke. Defaults to 'claude' (resolved via PATH). */
  command?: string;
  /** Optional --model override. */
  model?: string;
  /** Injected process-runner seam, for testability. Defaults to runHarnessProcess. */
  run?: (cmd: HarnessCommand, config: HarnessRunnerConfig) => Promise<HarnessSpawnResult>;
  /** Injected binary-presence probe, for testability. Defaults to a real PATH check. */
  probe?: () => Promise<BinaryProbe>;
}

interface ClaudeUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeModelUsageEntry {
  canonicalModel?: string;
}

interface ClaudeResultPayload {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: unknown;
  usage?: ClaudeUsagePayload;
  /** Per-model breakdown; `canonicalModel` fills the journal's `model` column. */
  modelUsage?: Record<string, ClaudeModelUsageEntry>;
  /**
   * Structured HTTP status when the CLI failed against the API. 429 is a
   * provider rate limit — the signal issue #3 was throwing away by bailing on
   * the exit code before this payload was ever parsed.
   */
  api_error_status?: number;
  terminal_reason?: string;
  /** Human-readable outcome; on a cap it names the reset time. */
  result?: string;
}

interface ClaudeRateLimitWindow {
  utilization?: number;
  /** Epoch SECONDS. */
  resetsAt?: number;
}

interface ClaudeRateLimitEvent {
  type?: string;
  rate_limit_info?: {
    status?: string;
    isUsingOverage?: boolean;
    unifiedWindows?: Record<string, ClaudeRateLimitWindow>;
  };
}

/** What one invocation's NDJSON stream yielded. */
interface ParsedClaudeStream {
  /** The terminal `result` event, if the stream produced one. */
  result: ClaudeResultPayload | null;
  /** Capacity snapshot from the last rate_limit_event, if any. */
  rateLimit: RateLimitSnapshot | undefined;
}

/**
 * Parse the `stream-json` NDJSON output into the two things we care about.
 *
 * Tolerant by construction: a malformed line is skipped rather than failing the
 * whole invocation, because this parse now runs on the FAILURE path too, where
 * a partially-written stream is likely. The LAST event of each kind wins — the
 * result event is terminal, and only the most recent capacity reading is
 * meaningful.
 */
export function parseClaudeStream(stdout: string): ParsedClaudeStream {
  let result: ClaudeResultPayload | null = null;
  let rateLimit: RateLimitSnapshot | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const type = (event as { type?: unknown }).type;

    if (type === 'result') {
      result = event as ClaudeResultPayload;
      continue;
    }
    if (type === 'rate_limit_event') {
      const info = (event as ClaudeRateLimitEvent).rate_limit_info;
      if (info === undefined) continue;
      const windows: RateLimitWindow[] = Object.entries(info.unifiedWindows ?? {})
        .filter(([, w]) => typeof w.utilization === 'number' && typeof w.resetsAt === 'number')
        // resetsAt is epoch SECONDS on the wire; everything downstream (
        // cards.release_at, the run loop's sleep) is milliseconds.
        .map(([name, w]) => ({ name, utilization: w.utilization!, resetsAtMs: w.resetsAt! * 1000 }));
      rateLimit = {
        ...(info.status !== undefined ? { status: info.status } : {}),
        ...(info.isUsingOverage !== undefined ? { usingOverage: info.isUsingOverage } : {}),
        windows,
      };
    }
  }
  return { result, rateLimit };
}

/**
 * When a rate-limited call may be retried, in epoch milliseconds.
 *
 * The BINDING window is the most-consumed one — with a five-hour and a seven-day
 * window in play, the one that actually capped you is the one nearest its
 * ceiling, and parking until the other resets would either return too early or
 * sleep for days. Returns undefined when no window was reported, leaving the
 * caller to apply its own default rather than inventing a reset time here.
 */
export function bindingResetAtMs(snapshot: RateLimitSnapshot | undefined): number | undefined {
  if (snapshot === undefined || snapshot.windows.length === 0) return undefined;
  let binding = snapshot.windows[0]!;
  for (const w of snapshot.windows) {
    if (w.utilization > binding.utilization) binding = w;
  }
  return binding.resetsAtMs;
}

/**
 * Throws a NAMED error — never resolve to a silent zero-usage success (AC4).
 * An optional `code` tags the two spawn-failure classes (timeout, non-zero
 * exit) so the executor can classify the throw (WI-566), following the
 * openai-adapter 'vision-unsupported' precedent (transform.ts reads
 * `(err as {code?}).code`). Untagged failures (parse/schema misses) still
 * throw a named claude-headless error — just without a `code` to key on.
 */
function fail(reason: string, code?: string, detail?: Record<string, unknown>): never {
  throw Object.assign(
    new Error(`claude-headless: ${reason}`),
    code !== undefined ? { code } : {},
    detail ?? {},
  );
}

async function defaultProbe(command: string): Promise<BinaryProbe> {
  const resolved = Bun.which(command);
  return resolved !== null
    ? { present: true, detail: resolved }
    : { present: false, detail: `'${command}' not found on PATH` };
}

export function createClaudeHarnessAdapter(config: ClaudeHarnessAdapterConfig): HarnessAdapter {
  const command = config.command ?? 'claude';
  const run = config.run ?? runHarnessProcess;
  const probe = config.probe ?? (() => defaultProbe(command));

  return {
    name: 'claude-headless',
    reportsUsage: true,
    canRestrictTools: true,
    model: config.model,

    async probeBinary(): Promise<BinaryProbe> {
      return probe();
    },

    async invoke(call: HarnessInvocation): Promise<HarnessResult> {
      // stream-json + --verbose rather than plain json: the NDJSON stream is the
      // only form that carries rate_limit_event, which reports capacity
      // utilization and reset times per window (issue #5). The terminal `result`
      // event carries the same fields the plain json output did.
      const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
      // Station wins over the adapter's configured default (FR-10, WI-589).
      const model = call.model ?? config.model;
      if (model !== undefined) {
        args.push('--model', model);
      }
      // Comma-joined single value — claude accepts comma- or space-separated.
      // Empty tools (the executor's encoding of a waived unrestricted_tools:
      // true station) passes through with NO narrowing flag.
      if (call.tools.length > 0) {
        args.push('--allowed-tools', call.tools.join(','));
      }
      // `--` terminates option parsing so the variadic --allowed-tools cannot
      // swallow the prompt positional.
      args.push('--', call.prompt);

      const spawnResult = await run(
        { command, args },
        {
          projectRoot: config.projectRoot,
          timeoutMs: call.timeoutMs,
          envAllowlist: config.envAllowlist,
        },
      );

      if (spawnResult.timedOut) {
        fail('invocation exceeded its timeout and was killed', 'harness-timeout');
      }

      // PARSE BEFORE THE EXIT-CODE BAIL (issue #3). A rate-limited call exits
      // NONZERO with an EMPTY stderr and puts every diagnostic — the 429, the
      // terminal reason, the reset time — on stdout. Bailing on the exit code
      // first, and then formatting the error from stderr, produced a journal row
      // reading "exited with code 1:" with nothing after the colon, and made a
      // provider cap indistinguishable from a segfault.
      const { result: payload, rateLimit } = parseClaudeStream(spawnResult.stdout);

      if (spawnResult.exitCode !== 0) {
        // A provider cap is not a crash: retrying it immediately cannot work,
        // and spending the card's remaining attempts on it in a few seconds is
        // what destroyed whole runs. Tag it distinctly so the executor can park
        // the card instead of burning the budget.
        if (payload?.api_error_status === 429) {
          const resetAtMs = bindingResetAtMs(rateLimit);
          fail(
            `provider rate limit: ${payload.result ?? 'no detail reported'}`,
            'harness-rate-limited',
            {
              ...(resetAtMs !== undefined ? { resetAtMs } : {}),
              ...(rateLimit !== undefined ? { rateLimit } : {}),
            },
          );
        }
        // Still nonzero, but the payload (when present) says far more than an
        // empty stderr ever did.
        const detail =
          payload !== null
            ? `${payload.terminal_reason ?? 'unknown reason'}: ${payload.result ?? ''}`.trim()
            : spawnResult.stderr.slice(0, 500);
        fail(`exited with code ${spawnResult.exitCode}: ${detail}`, 'harness-nonzero-exit');
      }

      if (payload === null) {
        fail('stdout carried no result event');
      }

      if (payload.is_error === true || (payload.subtype !== undefined && payload.subtype !== 'success')) {
        fail(`reported a non-success result (subtype=${String(payload.subtype)})`);
      }
      if (typeof payload.usage !== 'object' || payload.usage === null || Array.isArray(payload.usage)) {
        fail('response payload had a missing or malformed usage object');
      }
      if (typeof payload.total_cost_usd !== 'number') {
        fail('response payload had a missing or non-numeric total_cost_usd');
      }

      const usage = payload.usage;
      // Still the TRUE TOTAL across all four classes: run and wave budgets fold
      // this number, so it must not shrink to input+output when the breakdown
      // below splits it out. (These four are disjoint in claude's schema —
      // input_tokens is uncached input, not an inclusive total — so summing
      // them double-counts nothing.)
      const tokens =
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);

      // modelUsage names the model the provider actually billed, which is what
      // fills the journal's `model` column (empty on harness rows until now).
      // One entry is the common case; with several, there is no single honest
      // label, so leave it unset rather than pick arbitrarily.
      const modelEntries = Object.values(payload.modelUsage ?? {});
      const billedModel =
        modelEntries.length === 1 ? modelEntries[0]?.canonicalModel : undefined;

      return {
        outputs: [],
        usage: {
          tokens,
          cost: payload.total_cost_usd,
          breakdown: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
          },
          ...(billedModel !== undefined ? { model: billedModel } : {}),
          ...(rateLimit !== undefined ? { rateLimit } : {}),
        },
      };
    },
  };
}
