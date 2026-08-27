/**
 * CLI card-seeding fail-closed overwrite guard (safe input-seeding work).
 *
 * `conduit run --input <file>` (and --input-inline) writes the seed content
 * into the entry station's declared input path. Prior to this fix that write
 * was unconditional: if an operator had already staged a real file at that
 * path (e.g. a photo the flow is meant to process), the seed silently
 * clobbered it — corrupting downstream input with no trace back to the
 * seeding step (the failure surfaces much later as a confusing
 * worker/parse/watchdog-stall failure).
 *
 * Required (fail-closed, "escalate ambiguity; never guess"):
 *   - no file, or an empty file at the target → seed as before
 *   - file exists, non-empty, byte-identical to the seed → proceed, no
 *     rewrite (idempotent re-run)
 *   - file exists, non-empty, DIFFERS from the seed → refuse: clear stderr
 *     message naming the path, exit non-zero, target untouched, engine never
 *     invoked, no card inserted
 *
 * Uses the same injected-seam entry point and temp-project helper pattern as
 * cli.test.ts's WI-357 seeding tests (setupRunProject / makeCapturingEngine).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { main, type CliDeps, type CliIO, type RunEngineArgs } from './main';

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l: string) => lines.push(l),
    err: (l: string) => errors.push(l),
  };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
});

afterEach(() => {
  db.close();
});

function makeDeps(over: { runEngine?: (args: RunEngineArgs) => Promise<void> } = {}): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: over.runEngine ?? (async () => {}),
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

/**
 * Build a temp project dir with a valid single-station entry flow whose entry
 * station ('ideate') declares request.json as its input — the artifact
 * `conduit run --input`/`--input-inline` seeds. project_root '.' resolves to
 * the temp dir via chdir. Mirrors setupRunProject() in cli.test.ts.
 */
function setupRunProject(): { dir: string; flowPath: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-cli-overwrite-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{request.json}}');
  const flowYaml = `
flow: cli-overwrite-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [request.json]
    outputs: [idea.json]
    next: done
`;
  const flowPath = join(dir, 'flow.yaml');
  writeFileSync(flowPath, flowYaml);
  const prevCwd = process.cwd();
  process.chdir(dir);
  return {
    dir,
    flowPath,
    restore: () => {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeCapturingEngine(): { runEngine: (args: RunEngineArgs) => Promise<void>; cap: { called: boolean } } {
  const cap = { called: false };
  const runEngine = async (args: RunEngineArgs) => {
    cap.called = true;
    args.db.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete'").run();
  };
  return { runEngine, cap };
}

describe('conduit run — fail-closed refusal of a pre-staged differing entry input (safe input-seeding work)', () => {
  it('refuses --input seeding when the target file pre-exists, is non-empty, and differs: exit 1, file untouched, engine never invoked', async () => {
    const proj = setupRunProject();
    try {
      const targetPath = join(proj.dir, 'request.json');
      const stagedContent = 'x'.repeat(1000) + '-pre-staged-real-data';
      writeFileSync(targetPath, stagedContent, 'utf-8');

      const inputPath = join(proj.dir, 'my-input.json');
      writeFileSync(inputPath, '{"topic":"widgets"}');
      const { runEngine, cap } = makeCapturingEngine();

      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      expect(code).toBe(1);
      expect(cap.called).toBe(false);
      // The staged file must be byte-for-byte untouched.
      expect(readFileSync(targetPath, 'utf-8')).toBe(stagedContent);
      // No card should have been inserted for this run.
      const cardCount = (
        db.getStateDb().prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }
      ).n;
      expect(cardCount).toBe(0);
      // Error message names the target path and explains the refusal.
      const errText = io.errors.join('\n');
      expect(errText).toContain(targetPath);
      expect(errText).toMatch(/refus|overwrit|pre-staged/i);
    } finally {
      proj.restore();
    }
  });

  it('refuses --input-inline seeding the same way when the target file pre-exists and differs', async () => {
    const proj = setupRunProject();
    try {
      const targetPath = join(proj.dir, 'request.json');
      const stagedContent = 'binary-ish-pre-staged-content';
      writeFileSync(targetPath, stagedContent, 'utf-8');

      const { runEngine, cap } = makeCapturingEngine();

      const code = await main(
        ['run', proj.flowPath, '--input-inline', 'a great shoppable idea'],
        makeDeps({ runEngine }),
      );

      expect(code).toBe(1);
      expect(cap.called).toBe(false);
      expect(readFileSync(targetPath, 'utf-8')).toBe(stagedContent);
      const errText = io.errors.join('\n');
      expect(errText).toContain(targetPath);
    } finally {
      proj.restore();
    }
  });

  it('proceeds without rewriting when the pre-existing file is byte-identical to the seed content (idempotent re-run)', async () => {
    const proj = setupRunProject();
    try {
      const targetPath = join(proj.dir, 'request.json');
      const seedContent = '{"topic":"widgets"}';
      writeFileSync(targetPath, seedContent, 'utf-8');

      const inputPath = join(proj.dir, 'my-input.json');
      writeFileSync(inputPath, seedContent);
      const { runEngine, cap } = makeCapturingEngine();

      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      expect(code).toBe(0);
      expect(cap.called).toBe(true);
      expect(readFileSync(targetPath, 'utf-8')).toBe(seedContent);
    } finally {
      proj.restore();
    }
  });

  it('seeds normally when no pre-existing file is at the target path (regression guard for the normal path)', async () => {
    const proj = setupRunProject();
    try {
      const targetPath = join(proj.dir, 'request.json');
      expect(existsSync(targetPath)).toBe(false);

      const inputPath = join(proj.dir, 'my-input.json');
      writeFileSync(inputPath, '{"topic":"widgets"}');
      const { runEngine, cap } = makeCapturingEngine();

      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      expect(code).toBe(0);
      expect(cap.called).toBe(true);
      expect(existsSync(targetPath)).toBe(true);
      expect(readFileSync(targetPath, 'utf-8')).toContain('widgets');
    } finally {
      proj.restore();
    }
  });

  it('seeds normally when the pre-existing file is empty (zero bytes)', async () => {
    const proj = setupRunProject();
    try {
      const targetPath = join(proj.dir, 'request.json');
      writeFileSync(targetPath, '', 'utf-8');

      const inputPath = join(proj.dir, 'my-input.json');
      writeFileSync(inputPath, '{"topic":"widgets"}');
      const { runEngine, cap } = makeCapturingEngine();

      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      expect(code).toBe(0);
      expect(cap.called).toBe(true);
      expect(readFileSync(targetPath, 'utf-8')).toContain('widgets');
    } finally {
      proj.restore();
    }
  });
});

describe('conduit run — refusal leaves no zombie run-registry row, and a corrected retry actually runs (safe input-seeding work follow-up)', () => {
  it('refusal seeds no card and registers no run row; fixing the file and re-running the SAME command then seeds and invokes the engine', async () => {
    const proj = setupRunProject();
    try {
      const targetPath = join(proj.dir, 'request.json');
      const stagedContent = 'pre-staged-real-operator-data';
      writeFileSync(targetPath, stagedContent, 'utf-8');

      const inputPath = join(proj.dir, 'my-input.json');
      const seedContent = '{"topic":"widgets"}';
      writeFileSync(inputPath, seedContent);

      const argv = ['run', proj.flowPath, '--run-id', 'retry-job', '--input', inputPath];

      // First attempt: the target pre-exists, is non-empty, and differs from the
      // seed content — the run must refuse before registerRun ever commits a
      // row, otherwise this run-id is permanently stuck (registerRun would
      // report 'existing' on any later identical retry, printing state and
      // exiting 0 without ever seeding a card or invoking the engine).
      const first = makeCapturingEngine();
      const code1 = await main(argv, makeDeps({ runEngine: first.runEngine }));

      expect(code1).toBe(1);
      expect(first.cap.called).toBe(false);
      expect(readFileSync(targetPath, 'utf-8')).toBe(stagedContent);

      // No run-registry row must exist for this run-id after the refusal —
      // queried the same way run-namespacing.test.ts asserts registration.
      expect(db.getRun('retry-job')).toBeNull();

      const cardCountAfterRefusal = (
        db.getStateDb().prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }
      ).n;
      expect(cardCountAfterRefusal).toBe(0);

      // Operator follows the error's remediation advice: remove the stale file.
      rmSync(targetPath);

      // Re-run the identical command. Because no run-registry row was written
      // by the refused attempt, registerRun now sees a fresh run-id and
      // reports 'created' — the run actually seeds a card and invokes the
      // engine, instead of silently reporting a stuck 'existing' state.
      const second = makeCapturingEngine();
      const code2 = await main(argv, makeDeps({ runEngine: second.runEngine }));

      expect(code2).toBe(0);
      expect(second.cap.called).toBe(true);
      expect(db.getRun('retry-job')).not.toBeNull();

      const cardsAfterRetry = db
        .getStateDb()
        .prepare("SELECT id FROM cards WHERE run_id = 'retry-job'")
        .all() as Array<{ id: string }>;
      expect(cardsAfterRetry.length).toBeGreaterThanOrEqual(1);
      expect(readFileSync(targetPath, 'utf-8')).toBe(seedContent);
    } finally {
      proj.restore();
    }
  });
});

describe('conduit run — the overwrite guard compares raw bytes, not UTF-8-decoded strings (safe input-seeding work follow-up)', () => {
  it('refuses when the pre-staged target and the seed are different invalid-UTF-8 byte sequences that happen to decode to the same string', async () => {
    // 0xC0 and 0xC1 are both invalid UTF-8 lead bytes (overlong-encoding
    // forms) that Bun/Node's lenient UTF-8 decoder maps to a single U+FFFD
    // replacement character each — so as *decoded strings* they compare
    // equal, even though the underlying bytes differ. A comparison that
    // decodes both sides before comparing would treat these as identical and
    // silently skip seeding onto stale/corrupt binary content; a byte-wise
    // comparison must still catch the difference and refuse.
    const stagedBytes = Buffer.from([0xc0]);
    const seedBytes = Buffer.from([0xc1]);

    // Verify the premise before asserting on it: the two byte sequences must
    // decode to the same string (that's what makes this a real UTF-8-compare
    // trap) while still being different at the byte level.
    expect(stagedBytes.toString('utf-8')).toBe(seedBytes.toString('utf-8'));
    expect(stagedBytes.equals(seedBytes)).toBe(false);

    const proj = setupRunProject();
    try {
      const targetPath = join(proj.dir, 'request.json');
      writeFileSync(targetPath, stagedBytes);

      const inputPath = join(proj.dir, 'my-input.bin');
      writeFileSync(inputPath, seedBytes);

      const { runEngine, cap } = makeCapturingEngine();
      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      expect(code).toBe(1);
      expect(cap.called).toBe(false);
      // The pre-staged file must be byte-for-byte untouched.
      expect(readFileSync(targetPath).equals(stagedBytes)).toBe(true);
      const errText = io.errors.join('\n');
      expect(errText).toContain(targetPath);
      expect(errText).toMatch(/refus|overwrit|pre-staged/i);
    } finally {
      proj.restore();
    }
  });
});

describe('conduit run — the overwrite guard fails closed on filesystem errors inspecting the target, instead of crashing (safe input-seeding work follow-up)', () => {
  it('refuses --input seeding when the target path is a directory: exit 1, clear refusal, directory untouched, no card seeded', async () => {
    const proj = setupRunProject();
    try {
      const targetPath = join(proj.dir, 'request.json');
      mkdirSync(targetPath);
      writeFileSync(join(targetPath, 'marker.txt'), 'inside-the-directory');

      const inputPath = join(proj.dir, 'my-input.json');
      writeFileSync(inputPath, '{"topic":"widgets"}');
      const { runEngine, cap } = makeCapturingEngine();

      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      expect(code).toBe(1);
      expect(cap.called).toBe(false);
      // The directory and its contents must be untouched — not replaced by the seed file.
      expect(existsSync(targetPath)).toBe(true);
      expect(readFileSync(join(targetPath, 'marker.txt'), 'utf-8')).toBe('inside-the-directory');
      const cardCount = (
        db.getStateDb().prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }
      ).n;
      expect(cardCount).toBe(0);
      const errText = io.errors.join('\n');
      expect(errText).toContain(targetPath);
      expect(errText).toMatch(/directory|not a (regular )?file/i);
    } finally {
      proj.restore();
    }
  });

  // chmod 0o000 is ineffective as root (root bypasses file permission checks),
  // so this case is skipped when the test runner itself is root — there the
  // read would succeed and the assertions below would not exercise the guard.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)(
    'refuses --input seeding when the target file exists but is unreadable (permission denied), instead of crashing',
    async () => {
      const proj = setupRunProject();
      try {
        const targetPath = join(proj.dir, 'request.json');
        writeFileSync(targetPath, 'pre-staged-real-data', 'utf-8');
        chmodSync(targetPath, 0o000);

        const inputPath = join(proj.dir, 'my-input.json');
        writeFileSync(inputPath, '{"topic":"widgets"}');
        const { runEngine, cap } = makeCapturingEngine();

        try {
          const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

          expect(code).toBe(1);
          expect(cap.called).toBe(false);
          const cardCount = (
            db.getStateDb().prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }
          ).n;
          expect(cardCount).toBe(0);
          const errText = io.errors.join('\n');
          expect(errText).toContain(targetPath);
          expect(errText).toMatch(/refus|permission|unreadable|error/i);
        } finally {
          // Restore permissions so proj.restore()'s recursive rmSync can clean up.
          chmodSync(targetPath, 0o644);
        }
      } finally {
        proj.restore();
      }
    },
  );
});
