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
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
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

/**
 * `rate_limit_info` as the CLI actually emits it: ONE window per event, with
 * its fields FLAT at the top level and named by `rateLimitType`.
 *
 * `unifiedWindows` is kept as a fallback because some builds have been observed
 * carrying it, but the flat form is the one that must work — writing this
 * against the nested shape alone meant `windows` came back empty on every real
 * call, so the park silently fell back to its default interval and the
 * provider's own reset was never used.
 */
interface ClaudeRateLimitEvent {
  type?: string;
  rate_limit_info?: {
    status?: string;
    isUsingOverage?: boolean;
    /** Names the single flat window, e.g. 'five_hour' | 'seven_day'. */
    rateLimitType?: string;
    utilization?: number;
    /** Epoch SECONDS. */
    resetsAt?: number;
    unifiedWindows?: Record<string, ClaudeRateLimitWindow>;
  };
}

/**
 * The only two event types this adapter reads, matched on the RAW line so the
 * stream can be filtered without parsing (or retaining) the rest.
 *
 * A false positive — an assistant message quoting this text — is harmless:
 * parseClaudeStream still checks the real `type` field. A false NEGATIVE would
 * lose the result, so the pattern is deliberately loose about whitespace.
 */
const CLAUDE_KEPT_EVENT = /"type"\s*:\s*"(result|rate_limit_event)"/;

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

      // FLAT FIRST — this is the shape the CLI emits. resetsAt is epoch SECONDS
      // on the wire; everything downstream works in milliseconds.
      const windows: RateLimitWindow[] = [];
      if (typeof info.utilization === 'number' && typeof info.resetsAt === 'number') {
        windows.push({
          name: info.rateLimitType ?? 'window',
          utilization: info.utilization,
          resetsAtMs: info.resetsAt * 1000,
        });
      }
      // Nested fallback, for a build that reports every window at once. Merged
      // rather than replacing, so a payload carrying both is not halved.
      for (const [name, w] of Object.entries(info.unifiedWindows ?? {})) {
        if (typeof w.utilization !== 'number' || typeof w.resetsAt !== 'number') continue;
        if (windows.some((existing) => existing.name === name)) continue;
        windows.push({ name, utilization: w.utilization, resetsAtMs: w.resetsAt * 1000 });
      }

      rateLimit = {
        ...(info.status !== undefined ? { status: info.status } : {}),
        ...(info.isUsingOverage !== undefined ? { usingOverage: info.isUsingOverage } : {}),
        windows,
      };
    }
  }
  return { result, rateLimit };
}

/** Total tokens a modelUsage entry accounts for, across every class. */
function entryTokens(entry: ClaudeModelUsageEntry): number {
  return (
    (entry.inputTokens ?? 0) +
    (entry.outputTokens ?? 0) +
    (entry.cacheReadInputTokens ?? 0) +
    (entry.cacheCreationInputTokens ?? 0)
  );
}

/**
 * The model that did the bulk of the work, or undefined if none is reported.
 *
 * Ties break toward the first entry, which keeps the label stable rather than
 * dependent on key order.
 */
export function dominantModel(
  modelUsage: Record<string, ClaudeModelUsageEntry> | undefined,
): string | undefined {
  let best: { model: string; tokens: number } | undefined;
  for (const [key, entry] of Object.entries(modelUsage ?? {})) {
    const model = entry.canonicalModel ?? key;
    const tokens = entryTokens(entry);
    if (best === undefined || tokens > best.tokens) best = { model, tokens };
  }
  return best?.model;
}

/**
 * Blocking rate-limit states. `allowed_warning` is NOT one of them — it means
 * approaching a ceiling, not stopped at it, and treating it as a cap would park
 * cards that could still run.
 */
const BLOCKED_RATE_LIMIT_STATUSES = new Set(['blocked', 'rejected', 'exhausted', 'rate_limited']);

/** Phrasing the CLI uses when a subscription or session cap is what stopped it. */
const RATE_LIMIT_TEXT = /rate limit|rate_limit|session limit|usage limit|too many requests|\b429\b/i;

/**
 * Did this failed invocation fail because of a provider cap?
 *
 * Ordered most to least authoritative. The structured status is the only one
 * confirmed against a genuine cap; the other two exist so that a CLI which
 * reports the same condition differently still parks rather than scraps.
 */
export function isRateLimited(
  payload: ClaudeResultPayload | null,
  rateLimit: RateLimitSnapshot | undefined,
  stdout: string,
  stderr: string,
): boolean {
  if (payload?.api_error_status === 429) return true;
  if (rateLimit?.status !== undefined && BLOCKED_RATE_LIMIT_STATUSES.has(rateLimit.status)) return true;
  // Text is the LAST resort and only over the result field or a short stderr —
  // never the whole transcript, which could contain the phrase incidentally in
  // a tool output or a file the agent happened to read.
  const text = payload?.result ?? (stdout.length === 0 ? stderr.slice(0, 500) : '');
  return text.length > 0 && RATE_LIMIT_TEXT.test(text);
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
          // stream-json carries the whole agent transcript; we need two events
          // from it. Filtering as it arrives keeps a long station's memory
          // proportional to what we actually read, not to how much it did.
          stdoutLineFilter: (line) => CLAUDE_KEPT_EVENT.test(line),
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
        //
        // THREE signals, deliberately, because only the first is confirmed
        // against a real cap. If the CLI ever exits WITHOUT a terminal result
        // event, keying solely on api_error_status would throw untagged and
        // scrap — leaving issue #3 open under the exact condition it was filed
        // for. Degrading into a park is the safe direction: the worst case is
        // one short wait before the card runs again.
        if (isRateLimited(payload, rateLimit, spawnResult.stdout, spawnResult.stderr)) {
          const resetAtMs = bindingResetAtMs(rateLimit);
          fail(
            `provider rate limit: ${payload?.result ?? rateLimit?.status ?? 'no detail reported'}`,
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

      // modelUsage names the models the provider actually billed, filling the
      // journal's `model` column (empty on harness rows until now).
      //
      // TWO OR MORE entries is the NORMAL case, not the exception: Claude Code
      // bills a haiku model for side tasks alongside the main model, so even a
      // trivial call returns two. Requiring exactly one meant the column fell
      // back to the station's requested model on essentially every row —
      // delivering nothing #5 asked for. Attribute to the entry that consumed
      // the most tokens instead: that is the model that did the work and drove
      // the cost.
      const billedModel = dominantModel(payload.modelUsage);

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
