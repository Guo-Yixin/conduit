/**
 * Flag-gated real-binary E2E — research flow on the local claude CLI (WI-595).
 *
 * Phase-1 EXIT-CRITERION evidence, self-serve and headless: runs the committed
 * examples/research-flow.yaml (harness maker + adversarial harness critic) end
 * to end against the REAL local `claude` binary via subscription auth, then
 * asserts the journal evidence the exit criterion requires.
 *
 * GATED OFF BY DEFAULT (see src/packaging/compose-dev.test.ts precedent): it
 * runs ONLY when CONDUIT_E2E_CLAUDE is set AND a `claude` binary is on PATH. A
 * default `bun test` run skips it — no credentials, no binary, CI stays green.
 *
 * Reproduce the evidence run:  CONDUIT_E2E_CLAUDE=1 bun test src/integration/harness-e2e-claude.test.ts
 *
 * Production wiring (NOT fakes — the fakes path is WI-590's load test): the real
 * CONDUIT_HARNESS_* parsing (WI-586) -> buildHarnessDefinitionRegistry (WI-587)
 * -> per-run bindHarnessDefinitions (WI-588), exactly as buildProductionDeps
 * wires it, then runExecutor against a temp-dir project root with owned_paths +
 * enforce_owned_paths active (the fixture sets it), so the integrity gate is
 * exercised on the real run.
 *
 * Cost: haiku model, a one-line topic, a <100-word answer, a bounded per-run
 * token budget (fixture-bounded). Asserts against ONE real run of the flow —
 * the test itself never loops or retries; the flow's own bounded rework_cap
 * (the kernel's quality loop) may still fire internally within that one run.
 */

import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { parseHarnessConfig } from '../worker/harness-config';
import { buildHarnessDefinitionRegistry, bindHarnessDefinitions } from '../worker/harness-adapter';
import { runExecutor } from '../controller/executor';
import { loadFlow } from '../flow/load';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID, type StoredCardLogEntry } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';

const EXAMPLES = join(import.meta.dir, '../../examples');
const FLOW_PATH = join(EXAMPLES, 'research-flow.yaml');
const TOPIC_SRC = join(EXAMPLES, 'topic.md');

// Gate: opt-in env var AND a real claude binary present. Either missing -> skip.
const CLAUDE_PRESENT = Bun.which('claude') !== null;
const E2E_ENABLED = !!process.env.CONDUIT_E2E_CLAUDE && CLAUDE_PRESENT;

// A harness maker must never touch the model adapter.
const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness maker');
  },
};

// Captured stdout/stderr — scanned for secret leakage (NFR-1).
const captured: string[] = [];
const io = { out: (l: string) => captured.push(l), err: (l: string) => captured.push(l) };

describe.skipIf(!E2E_ENABLED)('harness E2E on the real claude binary (CONDUIT_E2E_CLAUDE=1)', () => {
  it(
    'runs research-flow to done on the real claude CLI with journal evidence and no secret leakage',
    async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'conduit-e2e-claude-'));
      // Seed the entry input into the run's project root (the maker reads it there).
      copyFileSync(TOPIC_SRC, join(projectRoot, 'topic.md'));

      // Register claude-headless through REAL CONDUIT_HARNESS_* env — the
      // subscription-auth minimum (HOME,PATH). A DECOY secret env var, NOT in the
      // allowlist, proves secret VALUES never reach the child or the journal.
      const DECOY_SECRET = 'DECOY_SECRET_VALUE_must_never_leak_7f3a91';
      const prevEnv: Record<string, string | undefined> = {
        CONDUIT_HARNESS_ADAPTERS: process.env.CONDUIT_HARNESS_ADAPTERS,
        CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: process.env.CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV,
        CONDUIT_E2E_DECOY_SECRET: process.env.CONDUIT_E2E_DECOY_SECRET,
      };
      process.env.CONDUIT_HARNESS_ADAPTERS = 'claude-headless';
      process.env.CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV = 'HOME,PATH';
      process.env.CONDUIT_E2E_DECOY_SECRET = DECOY_SECRET;

      let db: ConduitDB | null = null;
      try {
        // Production wiring: parse env -> definition registry -> per-run bind.
        const parsed = parseHarnessConfig(process.env);
        if (!parsed.ok) throw new Error(`CONDUIT_HARNESS_* parse failed: ${parsed.error}`);
        const definitions = buildHarnessDefinitionRegistry(parsed.defs);
        const registry = bindHarnessDefinitions(definitions, projectRoot);

        const loaded = loadFlow(FLOW_PATH, { harnessRegistry: registry });
        if (!loaded.ok) throw new Error(`research-flow.yaml did not load: ${JSON.stringify(loaded.errors)}`);

        db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
        ensureCheckpointSchema(db.getStateDb());
        db.insertCard({
          run_id: DEFAULT_RUN_ID,
          id: 'entry',
          parent_id: null,
          lane: 'research',
          status: 'ready',
          attempt: 0,
          wave: 0,
          owned_paths: ['topic.md', 'findings.md'],
          rework_count: 0,
        });

        await runExecutor({
          db,
          flow: loaded.flow,
          now: () => Math.floor(Date.now() / 1000),
          adapter: throwingModel,
          io,
          harnessRegistry: registry,
          projectRoot,
        } as RunEngineArgs);

        // ---- Assertions (Phase-1 exit-criterion evidence) ----
        const card = db.getCard(DEFAULT_RUN_ID, 'entry');
        const spans = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'entry');
        const cardLog = db.getCardLog('entry');
        const gateVerdicts = cardLog.filter(
          (e): e is Extract<StoredCardLogEntry, { kind: 'gate_verdict' }> => e.kind === 'gate_verdict',
        );
        const makerSpans = spans.filter(
          (s) => s.name.includes('harness') && (s as { adapter?: string }).adapter === 'claude-headless',
        );

        // AC2: the run reaches done on the real binary. Any number of BOUNDED
        // rework cycles ending in done is valid evidence (the kernel's own
        // rework loop self-healing a rejected attempt) — this does NOT require
        // zero gate rejections, only that the run eventually converges.
        //
        // A live adversarial critic can legitimately reject every attempt
        // within the rework cap (rare, but real model variance) — that is the
        // gate working as designed, not a wiring defect. When the card scraps
        // instead of reaching done, distinguish the two causes from the
        // journal evidence itself rather than an opaque test failure.
        if (card?.lane !== 'done') {
          const wellFormedVerdicts =
            gateVerdicts.length > 0 &&
            gateVerdicts.every((v) => (v.verdict === 'pass' || v.verdict === 'reject') && Array.isArray(v.findings));
          const allRejected = gateVerdicts.length > 0 && gateVerdicts.every((v) => v.verdict === 'reject');
          if (wellFormedVerdicts && allRejected && makerSpans.length >= 1) {
            throw new Error(
              `JUDGMENT SCRAP: mechanism verified, critic rejected ${gateVerdicts.length}x — re-run the evidence test. ` +
                `${makerSpans.length} maker span(s) and ${gateVerdicts.length} well-formed gate_verdict row(s) recorded, ` +
                `all reject — the harness/registry/rework wiring is confirmed correct; this is live-model judgment ` +
                `variance within the flow's rework cap, not a code defect.`,
            );
          }
          throw new Error(
            `WIRING FAILURE: card ended in lane '${card?.lane}' (expected 'done') with evidence that does NOT look ` +
              `like a clean critic rejection (maker spans=${makerSpans.length}, gate_verdict rows=${gateVerdicts.length}, ` +
              `well-formed=${wellFormedVerdicts}) — investigate the harness/registry/gate wiring, not model judgment.`,
          );
        }
        expect(card?.lane).toBe('done');

        // AC3: per-attempt harness rows for the maker (claude-headless).
        expect(makerSpans.length).toBeGreaterThanOrEqual(1);
        // Usage where the adapter reports it (claude reports token usage; not the
        // explicit-unknown sentinel), attributed to the maker station's attempt.
        expect(makerSpans.some((s) => (s as { usageUnknown?: boolean }).usageUnknown === false)).toBe(true);
        expect(db.getStationUsage('entry', 'research', 0)).not.toBeNull();

        // AC3: gate verdict rows for the adversarial critic (FR-3: a gate_verdict
        // card-log entry is appended on every gate check).
        expect(gateVerdicts.length).toBeGreaterThanOrEqual(1);

        // NFR-1: no secret VALUES in journal rows, card log, or captured output —
        // env var NAMES only. The decoy secret (not in the HOME,PATH allowlist)
        // must never appear anywhere the run recorded.
        const recorded = `${JSON.stringify(spans)}\n${JSON.stringify(cardLog)}\n${captured.join('\n')}`;
        expect(recorded).not.toContain(DECOY_SECRET);
      } finally {
        for (const [k, v] of Object.entries(prevEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        db?.close();
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
