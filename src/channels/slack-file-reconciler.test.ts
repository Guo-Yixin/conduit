/**
 * File-delivery reconciler: files.info/thread-history probe for pending-intent
 * resume (WI-602, PRD FR-3/4/11/12, NFR-1/3/4). Layers onto WI-598's egressSendFile
 * reconciler param and WI-599's delivery path — the hold-only base (no reconciler)
 * stays the default; this supplies a REAL probe so the safe crash window
 * auto-resumes.
 *
 * ── Contract this file pins for src/channels/slack.ts (team-lead confirmed) ──
 *
 *  - A widened `FileReconciler` type is EXPORTED (the sync Reconciler that
 *    reconcileOnResume consumes is left untouched):
 *      type FileReconciler = (intent: Record<string, unknown>)
 *        => ('landed' | 'not_landed' | 'unknown') | Promise<'landed' | 'not_landed' | 'unknown'>;
 *  - createFilesInfoReconciler({ botToken, fetchImpl?, apiBaseUrl?, channel, threadTs? }): FileReconciler
 *      probes the channel/thread (files.list / conversations.replies) and matches
 *      the pending intent payload on basename(path) + size (the content fingerprint
 *      stays the OUTBOX key, not the probe key — Slack exposes no content hash):
 *        exactly one name+size match      → 'landed'
 *        queryable, no match              → 'not_landed'
 *        multiple matches / any anomaly   → 'unknown'  (FAIL-CLOSED — never guess landed)
 *        probe error (ok:false / throw)   → 'unknown'
 *      The bot token NEVER surfaces in any error/log on a probe failure (NFR-1).
 *  - egressSendFile AWAITS the FileReconciler inline for a pending intent, with
 *    byte-identical skip/fire/escalate semantics, and RETURNS the decision:
 *      EgressResult gains `reconcileDecision?: 'skip' | 'fire' | 'escalate'`.
 *
 * (AC5's per-attempt journal half is pinned in executor-file-delivery.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { egressSendFile, type SlackTransport, type EgressResult } from './slack';
import * as slackModule from './slack';

const BOT_TOKEN = 'xoxb-SECRET-do-not-leak-9f3a2b';
const CHANNEL = 'C123';
const FILE_CONTENT = 'x'.repeat(100); // 100 bytes → intent.size === 100

type Decision = 'landed' | 'not_landed' | 'unknown';
type FileReconcilerFn = (intent: Record<string, unknown>) => Decision | Promise<Decision>;
type CreateFilesInfoReconciler = (config: {
  botToken: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  channel: string;
  threadTs?: string;
}) => FileReconcilerFn;

const _createFilesInfoReconciler = (slackModule as { createFilesInfoReconciler?: CreateFilesInfoReconciler })
  .createFilesInfoReconciler;

/** Read the WI-602 factory structurally so this file loads before it exists. */
function createFilesInfoReconciler(config: Parameters<CreateFilesInfoReconciler>[0]): FileReconcilerFn {
  if (typeof _createFilesInfoReconciler !== 'function') {
    throw new Error(
      'src/channels/slack.ts must export createFilesInfoReconciler({ botToken, fetchImpl?, apiBaseUrl?, channel, threadTs? })' +
        ' — the WI-602 files.info/thread-history reconciler.',
    );
  }
  return _createFilesInfoReconciler(config);
}

/** The reconcile-decision egressSendFile must surface on its result (WI-602 AC5). */
function reconcileDecisionOf(result: EgressResult): string | undefined {
  return (result as { reconcileDecision?: string }).reconcileDecision;
}

/** A fake Slack probe response: files present (files.list AND conversations.replies shapes). */
function makeProbeFetch(opts: {
  files?: Array<{ name: string; size: number }>;
  mode?: 'ok' | 'okFalse' | 'throw';
  error?: string;
  /** Simulate a paginated result (a further page exists) — a zero-match here is NOT provably absent. */
  hasMore?: boolean;
  nextCursor?: string;
}): { fetchImpl: typeof fetch; calls: string[] } {
  const files = opts.files ?? [];
  const calls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    calls.push(String(url));
    if (opts.mode === 'throw') return Promise.reject(new Error(opts.error ?? 'probe network error'));
    if (opts.mode === 'okFalse') {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: opts.error ?? 'access_denied' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    // Tolerant of endpoint choice: expose both a files.list array and a
    // conversations.replies message list carrying the same files.
    const body: Record<string, unknown> = { ok: true, files, messages: [{ files }] };
    if (opts.hasMore !== undefined) body.has_more = opts.hasMore;
    if (opts.nextCursor !== undefined) body.response_metadata = { next_cursor: opts.nextCursor };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** The persisted outbox intent shape egressSendFile writes (path/size/fingerprint). */
function uploadIntent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'slack_upload_file',
    channel: CHANNEL,
    path: 'work/edited.jpg',
    size: 100,
    fingerprint: 'deadbeef',
    threadTs: undefined,
    caption: undefined,
    ...over,
  };
}

function leakSurface(err: unknown): string {
  const e = err as Error;
  let extra = '';
  try {
    extra = JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}));
  } catch {
    extra = '';
  }
  return `${String(err)}\n${e?.message ?? ''}\n${e?.stack ?? ''}\n${extra}`;
}

interface UploadCall {
  channel: string;
  filePath: string;
}
/** A recording file transport; failAlways makes uploadFile throw (crash the attempt). */
function recordingFileTransport(opts: { failAlways?: boolean } = {}): { uploads: UploadCall[]; transport: SlackTransport } {
  const uploads: UploadCall[] = [];
  const transport: SlackTransport = {
    post: async () => ({ ts: 'ts' }),
    uploadFile: async (req) => {
      uploads.push({ channel: req.channel, filePath: req.filePath });
      if (opts.failAlways) throw new Error('simulated upload crash (nothing posted)');
      return { ok: true, files: [{ id: `F-${uploads.length}` }] };
    },
  };
  return { uploads, transport };
}

let dir: string;
let db: ConduitDB;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-reconciler-'));
  db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: join(dir, 'journal.sqlite') });
  ensureCheckpointSchema(db.getStateDb());
  filePath = join(dir, 'edited.jpg');
  writeFileSync(filePath, FILE_CONTENT);
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

function outboxRows(): Array<{ delivered_at: number | null }> {
  return db.getStateDb().prepare('SELECT delivered_at FROM outbox').all() as Array<{ delivered_at: number | null }>;
}

const KEY_PREFIX = 'run1/c1/deliver/0/work/edited.jpg';

/** Crash the first delivery attempt so a PENDING (uncommitted) intent remains. */
async function seedPendingIntent(): Promise<void> {
  const crashing = recordingFileTransport({ failAlways: true });
  await egressSendFile(db, crashing.transport, { channel: CHANNEL, filePath, keyPrefix: KEY_PREFIX }).catch(() => {});
  expect(outboxRows()).toHaveLength(1);
  expect(outboxRows()[0]!.delivered_at).toBeNull();
}

// ===========================================================================
// AC1 — the probe returns landed / not_landed / unknown (FR-3/FR-4)
// ===========================================================================

describe('createFilesInfoReconciler — probe decisions (AC1)', () => {
  it.each([
    ['exactly one name+size match → landed', [{ name: 'edited.jpg', size: 100 }], 'landed'],
    ['queryable, no match → not_landed', [{ name: 'other.jpg', size: 50 }], 'not_landed'],
    ['multiple matches → unknown (fail-closed)', [{ name: 'edited.jpg', size: 100 }, { name: 'edited.jpg', size: 100 }], 'unknown'],
  ] as [string, Array<{ name: string; size: number }>, Decision][])(
    '%s',
    async (_label, files, expected) => {
      const { fetchImpl } = makeProbeFetch({ files });
      const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl, channel: CHANNEL });
      expect(await reconciler(uploadIntent())).toBe(expected);
    },
  );

  it.each([
    ['ok:false', 'okFalse'],
    ['network throw', 'throw'],
  ] as [string, 'okFalse' | 'throw'][])(
    'an unanswerable probe (%s) returns unknown — fail-closed, never guess landed',
    async (_label, mode) => {
      const { fetchImpl } = makeProbeFetch({ mode });
      const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl, channel: CHANNEL });
      expect(await reconciler(uploadIntent())).toBe('unknown');
    },
  );

  // Review MEDIUM: 'not_landed' is the ONLY verdict that re-fires an upload, so
  // it must be PROVABLE. A zero-match on a PAGINATED result (a further page
  // exists) cannot prove absence — the file could be on a later page — so it
  // must fail closed to 'unknown', never re-fire into a double-post.
  it.each([
    ['has_more: true', { hasMore: true }],
    ['non-empty next_cursor', { nextCursor: 'dXNlcjpXWFEz' }],
  ] as [string, { hasMore?: boolean; nextCursor?: string }][])(
    'a zero-match on a paginated probe (%s) returns unknown, NOT not_landed',
    async (_label, paging) => {
      const { fetchImpl } = makeProbeFetch({ files: [{ name: 'other.jpg', size: 50 }], ...paging });
      const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl, channel: CHANNEL });
      expect(await reconciler(uploadIntent())).toBe('unknown');
    },
  );

  it('a zero-match on a provably COMPLETE probe (no more pages) still concludes not_landed', async () => {
    const { fetchImpl } = makeProbeFetch({
      files: [{ name: 'other.jpg', size: 50 }],
      hasMore: false,
      nextCursor: '',
    });
    const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl, channel: CHANNEL });
    expect(await reconciler(uploadIntent())).toBe('not_landed');
  });
});

// ===========================================================================
// AC2 — safe window: a probe that proves NOT-landed re-fires the delivery and
//       lands exactly once, no double-post (reconcile 'fire', decision 5)
// ===========================================================================

describe('file reconciler + egressSendFile — safe-window re-fire (AC2)', () => {
  it('re-fires and commits exactly once when the probe proves the file did not land', async () => {
    await seedPendingIntent();

    const probe = makeProbeFetch({ files: [] }); // channel queried, file is not there
    const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl: probe.fetchImpl, channel: CHANNEL });
    const t2 = recordingFileTransport(); // the re-fired upload now succeeds

    const result = await egressSendFile(db, t2.transport, { channel: CHANNEL, filePath, keyPrefix: KEY_PREFIX }, reconciler);

    expect(result.posted).toBe(true);
    expect(reconcileDecisionOf(result)).toBe('fire');
    expect(t2.uploads).toHaveLength(1); // fired once on resume
    // Exactly one landed file — the pending row was committed, never a second insert.
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivered_at).not.toBeNull();
  });
});

// ===========================================================================
// AC3 — an unanswerable probe still escalates to hold (fail-closed, FR-11)
// ===========================================================================

describe('file reconciler + egressSendFile — unanswerable probe escalates (AC3)', () => {
  it('escalates to hold and never re-uploads when the probe cannot determine the outcome', async () => {
    await seedPendingIntent();

    const probe = makeProbeFetch({ mode: 'throw' }); // probe cannot answer
    const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl: probe.fetchImpl, channel: CHANNEL });
    const t2 = recordingFileTransport();

    const result = await egressSendFile(db, t2.transport, { channel: CHANNEL, filePath, keyPrefix: KEY_PREFIX }, reconciler);

    expect(result.posted).toBe(false);
    expect(result.escalatedToHold).toBe(true);
    expect(reconcileDecisionOf(result)).toBe('escalate');
    expect(t2.uploads).toHaveLength(0); // never blind re-uploaded
    expect(outboxRows()[0]!.delivered_at).toBeNull(); // still pending
  });
});

// ===========================================================================
// AC4 — the bot token never surfaces on a probe failure (NFR-1)
// ===========================================================================

describe('createFilesInfoReconciler — token redaction on probe failure (AC4)', () => {
  it.each([
    ['a network throw embedding the token', 'throw'],
    ['an ok:false error embedding the token', 'okFalse'],
  ] as [string, 'throw' | 'okFalse'][])(
    'never leaks the bot token when the probe fails via %s',
    async (_label, mode) => {
      const { fetchImpl } = makeProbeFetch({ mode, error: `boom Authorization: Bearer ${BOT_TOKEN}` });
      const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl, channel: CHANNEL });

      const logs: string[] = [];
      const cap = (...a: unknown[]): void => {
        logs.push(a.map((x) => String(x)).join(' '));
      };
      const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
      console.log = cap; console.info = cap; console.warn = cap; console.error = cap; console.debug = cap;

      let decision: Decision | undefined;
      let threw = false;
      try {
        decision = await reconciler(uploadIntent());
      } catch (e) {
        threw = true;
        expect(leakSurface(e)).not.toContain(BOT_TOKEN);
      } finally {
        console.log = orig.log; console.info = orig.info; console.warn = orig.warn; console.error = orig.error; console.debug = orig.debug;
      }

      // A probe failure is swallowed into a fail-closed 'unknown' — never thrown…
      expect(threw).toBe(false);
      expect(decision).toBe('unknown');
      // …and the token appears in no log line.
      expect(logs.join('\n')).not.toContain(BOT_TOKEN);
    },
  );
});

// ===========================================================================
// AC5 (channels half) — egressSendFile surfaces the reconcile decision so the
//       executor can journal it. 'skip' when the probe proves it already landed.
//       ('fire' and 'escalate' are asserted in AC2/AC3; the per-attempt journal
//       assertion lives in executor-file-delivery.test.ts.)
// ===========================================================================

describe('file reconciler + egressSendFile — surfaced reconcile decision (AC5)', () => {
  it('skips (no re-upload) and reports decision=skip when the probe proves the file already landed', async () => {
    await seedPendingIntent();

    const probe = makeProbeFetch({ files: [{ name: 'edited.jpg', size: 100 }] }); // it DID land
    const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl: probe.fetchImpl, channel: CHANNEL });
    const t2 = recordingFileTransport();

    const result = await egressSendFile(db, t2.transport, { channel: CHANNEL, filePath, keyPrefix: KEY_PREFIX }, reconciler);

    expect(result.posted).toBe(false);
    expect(reconcileDecisionOf(result)).toBe('skip');
    expect(t2.uploads).toHaveLength(0); // already landed → never re-uploaded
    // Amy FLAG: a 'landed' skip must COMMIT the pending row (parity with the
    // 'fire' branch) so the intent converges — a later resume skips outright
    // without re-probing, and the row never lingers pending forever.
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivered_at).not.toBeNull();
  });
});
