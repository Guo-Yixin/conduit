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

import type { HarnessAdapter, HarnessInvocation, HarnessResult, BinaryProbe } from './harness-adapter';
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

interface ClaudeResultPayload {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: unknown;
  usage?: ClaudeUsagePayload;
}

/**
 * Throws a NAMED error — never resolve to a silent zero-usage success (AC4).
 * An optional `code` tags the two spawn-failure classes (timeout, non-zero
 * exit) so the executor can classify the throw (WI-566), following the
 * openai-adapter 'vision-unsupported' precedent (transform.ts reads
 * `(err as {code?}).code`). Untagged failures (parse/schema misses) still
 * throw a named claude-headless error — just without a `code` to key on.
 */
function fail(reason: string, code?: string): never {
  throw Object.assign(new Error(`claude-headless: ${reason}`), code !== undefined ? { code } : {});
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
      const args: string[] = ['-p', '--output-format', 'json'];
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
      if (spawnResult.exitCode !== 0) {
        fail(`exited with code ${spawnResult.exitCode}: ${spawnResult.stderr.slice(0, 500)}`, 'harness-nonzero-exit');
      }

      let payload: ClaudeResultPayload;
      try {
        payload = JSON.parse(spawnResult.stdout) as ClaudeResultPayload;
      } catch {
        fail('stdout was not valid JSON');
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
      const tokens =
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);

      return {
        outputs: [],
        usage: { tokens, cost: payload.total_cost_usd },
      };
    },
  };
}
