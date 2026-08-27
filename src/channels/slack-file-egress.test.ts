/**
 * Outbox-guarded file egress send — egressSendFile + attempt/fingerprint
 * idempotency key, plus the threaded-text egressSend rider (WI-598, PRD "Slack
 * Egress File Delivery" §6 FR-3/4/5/7, NFR-2/3, §9 decision 5).
 *
 * SEND layer. egressSendFile wraps the WI-597 transport.uploadFile in the SAME
 * effectful-outbox protocol egressSend uses (slack.ts:85): write a pending
 * intent, fire the completion, commit — so the upload is exactly-once under
 * crash/resume. Steps 1-2 of the transport three-step (URL acquire + byte POST)
 * are re-runnable; only the completion is the guarded edge.
 *
 * ── Contract this file pins for src/channels/slack.ts ──
 *
 *   export async function egressSendFile(
 *     db: ConduitDB,
 *     transport: SlackTransport,
 *     req: {
 *       channel: string;
 *       filePath: string;
 *       keyPrefix: string;   // caller-composed from (run, card, station, attempt, file)
 *       threadTs?: string;
 *       caption?: string;
 *     },
 *     reconciler?: Reconciler,
 *   ): Promise<EgressResult>;
 *
 *   Protocol (mirror egressSend):
 *     - fingerprint = sha256(file bytes read at send time); idempotencyKey =
 *       keyPrefix combined with fingerprint (deterministic). A changed artifact
 *       or a later attempt (different prefix) => different key => re-delivers;
 *       same bytes + same prefix => same key => dedup.
 *     - committed  → skip (posted:false), no re-upload.
 *     - pending    → reconcileOnResume: no reconciler → escalatedToHold:true;
 *                    'landed' → skip; 'not_landed' → fire (upload + commit).
 *     - none       → writePendingIntent → uploadFile → commitIntent → posted:true.
 *     - a missing/unreadable file → a typed error naming the path, BEFORE any
 *       outbox write (no stored bytes, no silent success).
 *     - the persisted intent payload carries only the path, size, and sha256
 *       fingerprint — NEVER the file bytes.
 *     - a transport lacking uploadFile → a diagnosable error, not a crash.
 *
 *   EgressMessage gains an optional `threadTs` forwarded to transport.post;
 *   unthreaded callers are byte-identical (no thread_ts).
 *
 * NO new outbox machinery — reuse writePendingIntent/reconcileOnResume/commitIntent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema, type Reconciler } from '../checkpoint/checkpoint';
import { egressSend, type SlackTransport, type EgressResult } from './slack';
import * as slackModule from './slack';

/**
 * egressSendFile is the WI-598 export under test. It is read STRUCTURALLY (via a
 * namespace import) rather than as a named import so THIS FILE LOADS even before
 * the export exists — a missing named import is a module-load SyntaxError that
 * would block every test. The wrapper throws a crisp RED naming the missing
 * export until B.A. adds it; once it exists, every test drives the real function.
 */
type EgressSendFileFn = (
  db: ConduitDB,
  transport: SlackTransport,
  req: { runId?: string; channel: string; filePath: string; keyPrefix: string; threadTs?: string; caption?: string },
  reconciler?: Reconciler,
) => Promise<EgressResult>;

const _egressSendFile = (slackModule as { egressSendFile?: EgressSendFileFn }).egressSendFile;

function egressSendFile(...args: Parameters<EgressSendFileFn>): Promise<EgressResult> {
  if (typeof _egressSendFile !== 'function') {
    throw new Error(
      'src/channels/slack.ts must export egressSendFile(db, transport, ' +
        '{ channel, filePath, keyPrefix, threadTs?, caption? }, reconciler?) — WI-598 outbox-guarded file delivery.',
    );
  }
  return _egressSendFile(...args);
}

const FILE_CONTENT = 'PRETEND-JPEG-BYTES-and-a-distinctive-marker-9f3a2b';
const THREAD_TS = '1699999999.123456';

let dir: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-file-egress-'));
  db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: join(dir, 'journal.sqlite') });
  ensureCheckpointSchema(db.getStateDb());
});
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Write `content` to a fresh file under the temp dir and return its path. */
function makeFile(content: string, name = 'edited.jpg'): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

/** sha256 hex of a file's bytes — the fingerprint the impl must persist (house standard). */
function fingerprintOf(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

interface UploadCall {
  channel: string;
  filePath: string;
  threadTs?: string;
  caption?: string;
}

/**
 * A recording Slack transport whose uploadFile captures each call. `failFirst`
 * makes ONLY the first uploadFile call throw (simulating a crash after the
 * pending intent is written but before commit) while later calls succeed;
 * `failAlways` throws every time.
 */
function recordingFileTransport(opts: { failFirst?: boolean; failAlways?: boolean } = {}): {
  uploads: UploadCall[];
  transport: SlackTransport;
} {
  const uploads: UploadCall[] = [];
  const transport: SlackTransport = {
    post: async () => ({ ts: 'ts-post' }),
    uploadFile: async (req) => {
      uploads.push({ channel: req.channel, filePath: req.filePath, threadTs: req.threadTs, caption: req.caption });
      if (opts.failAlways || (opts.failFirst && uploads.length === 1)) {
        throw new Error('simulated upload crash');
      }
      return { ok: true, files: [{ id: `F-${uploads.length}` }] };
    },
  };
  return { uploads, transport };
}

/** All outbox rows for direct assertion (no idempotency key needed). */
function outboxRows(): Array<{ run_id: string; idempotency_key: string; payload_json: string; delivered_at: number | null }> {
  return db!
    .getStateDb()
    .prepare('SELECT run_id, idempotency_key, payload_json, delivered_at FROM outbox')
    .all() as Array<{ run_id: string; idempotency_key: string; payload_json: string; delivered_at: number | null }>;
}

// ===========================================================================
// AC1 — clean first delivery: pending → upload → commit → posted:true
// ===========================================================================

describe('egressSendFile — clean first delivery (AC1/FR-3)', () => {
  it('writes a pending intent, uploads the file, commits the intent, and returns posted:true', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const { uploads, transport } = recordingFileTransport();

    const result = await egressSendFile(db!, transport, {
      channel: '#deliveries',
      filePath,
      keyPrefix: 'run1::c1::deliver::0::edited.jpg',
    });

    expect(result.posted).toBe(true);
    // uploadFile invoked exactly once with the target channel + file.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.channel).toBe('#deliveries');
    expect(uploads[0]!.filePath).toBe(filePath);
    // The single outbox intent is committed (a resume would skip it).
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivered_at).not.toBeNull();
  });

  it('forwards threadTs and caption to transport.uploadFile', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const { uploads, transport } = recordingFileTransport();

    await egressSendFile(db!, transport, {
      channel: '#deliveries',
      filePath,
      keyPrefix: 'run1::c1::deliver::0::edited.jpg',
      threadTs: THREAD_TS,
      caption: 'here is your edit',
    });

    expect(uploads[0]!.threadTs).toBe(THREAD_TS);
    expect(uploads[0]!.caption).toBe('here is your edit');
  });
});

// ===========================================================================
// AC2 — committed intent on entry → skip (resume never double-uploads)
// ===========================================================================

describe('egressSendFile — committed intent skips on resume (AC2/FR-3)', () => {
  it('does NOT re-upload when the same key (same prefix + same bytes) is already committed', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const keyPrefix = 'run1::c1::deliver::0::edited.jpg';
    const { uploads, transport } = recordingFileTransport();

    const first = await egressSendFile(db!, transport, { channel: '#deliveries', filePath, keyPrefix });
    expect(first.posted).toBe(true);
    expect(uploads).toHaveLength(1);

    // Simulated resume: identical prefix + unchanged bytes → same key → skip.
    const second = await egressSendFile(db!, transport, { channel: '#deliveries', filePath, keyPrefix });
    expect(second.posted).toBe(false);
    expect(uploads).toHaveLength(1); // NOT uploaded twice
  });
});

// ===========================================================================
// AC3 — pending intent on entry → reconcile (escalate / skip / fire), never
//        blind re-upload (FR-3, 'crash between completion and commit')
// ===========================================================================

describe('egressSendFile — pending-on-resume reconciliation (AC3/FR-3)', () => {
  /**
   * Drive a real crash: the first uploadFile throws AFTER the pending intent is
   * written, leaving a pending outbox row. The second call is the resume.
   */
  async function crashLeavingPending(filePath: string, keyPrefix: string) {
    const { uploads, transport } = recordingFileTransport({ failFirst: true });
    let threw = false;
    try {
      await egressSendFile(db!, transport, { channel: '#deliveries', filePath, keyPrefix });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Precondition for the resume tests: exactly one pending (uncommitted) row.
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivered_at).toBeNull();
    return { uploads, transport };
  }

  it('escalates to hold (no reconciler) and never re-uploads', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const keyPrefix = 'run1::c1::deliver::0::edited.jpg';
    const { uploads, transport } = await crashLeavingPending(filePath, keyPrefix);

    const result = await egressSendFile(db!, transport, { channel: '#deliveries', filePath, keyPrefix });

    expect(result.posted).toBe(false);
    expect(result.escalatedToHold).toBe(true);
    expect(uploads).toHaveLength(1); // the crashed attempt only — never re-uploaded
    // Still pending — NOT auto-committed, NOT blind-fired.
    expect(outboxRows()[0]!.delivered_at).toBeNull();
  });

  it('skips (no re-upload) when a reconciler confirms the prior upload already landed', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const keyPrefix = 'run1::c1::deliver::0::edited.jpg';
    const { uploads, transport } = await crashLeavingPending(filePath, keyPrefix);

    const result = await egressSendFile(
      db!,
      transport,
      { channel: '#deliveries', filePath, keyPrefix },
      () => 'landed',
    );

    expect(result.posted).toBe(false);
    expect(uploads).toHaveLength(1); // already landed → no double-upload
  });

  it('re-uploads exactly once (reusing the pending row) when a reconciler confirms it did NOT land', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const keyPrefix = 'run1::c1::deliver::0::edited.jpg';
    const { uploads, transport } = await crashLeavingPending(filePath, keyPrefix);

    const result = await egressSendFile(
      db!,
      transport,
      { channel: '#deliveries', filePath, keyPrefix },
      () => 'not_landed',
    );

    expect(result.posted).toBe(true);
    expect(uploads).toHaveLength(2); // the crashed attempt + one confirmed re-upload
    // The existing pending row was committed (not a second inserted row).
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivered_at).not.toBeNull();
  });
});

// ===========================================================================
// AC4 — idempotency key = caller prefix + content fingerprint (FR-5, decision 5)
// ===========================================================================

describe('egressSendFile — attempt+fingerprint idempotency key (AC4/FR-5)', () => {
  it('re-delivers when the artifact bytes change under the SAME prefix (fingerprint is in the key)', async () => {
    const filePath = makeFile('ORIGINAL-ARTIFACT-BYTES');
    const keyPrefix = 'run1::c1::deliver::0::edited.jpg';
    const { uploads, transport } = recordingFileTransport();

    const first = await egressSendFile(db!, transport, { channel: '#deliveries', filePath, keyPrefix });
    expect(first.posted).toBe(true);

    // Rework: the QC back-edge produced a NEW artifact at the same path, same prefix.
    writeFileSync(filePath, 'REWORKED-DIFFERENT-BYTES');
    const second = await egressSendFile(db!, transport, { channel: '#deliveries', filePath, keyPrefix });

    // Different content fingerprint → different key → a genuine re-delivery.
    expect(second.posted).toBe(true);
    expect(uploads).toHaveLength(2);
    expect(outboxRows()).toHaveLength(2);
  });

  it('re-delivers when the attempt (prefix) changes under the SAME bytes (attempt is in the key)', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const { uploads, transport } = recordingFileTransport();

    const attempt0 = await egressSendFile(db!, transport, {
      channel: '#deliveries',
      filePath,
      keyPrefix: 'run1::c1::deliver::0::edited.jpg',
    });
    expect(attempt0.posted).toBe(true);

    // A later execution attempt (rework) delivers the same bytes again.
    const attempt1 = await egressSendFile(db!, transport, {
      channel: '#deliveries',
      filePath,
      keyPrefix: 'run1::c1::deliver::1::edited.jpg',
    });

    expect(attempt1.posted).toBe(true);
    expect(uploads).toHaveLength(2);
    expect(outboxRows()).toHaveLength(2);
  });

  // Review HIGH (FR-5): the outbox is UNIQUE(run_id, idempotency_key). Two
  // DIFFERENT runs that compute the SAME key — identical card/station/attempt/
  // bytes, which recurs because card ids repeat across runs — must NOT collide:
  // run 2 must deliver, not silently skip on run 1's committed intent. Absent
  // run scoping, `getIntentStatus` falls back to DEFAULT_RUN_ID and both runs
  // share one namespace, so run 2 sees 'committed' and drops the delivery.
  it('does NOT skip when a DIFFERENT run reuses the same idempotency key (run-scoped outbox)', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const sharedKeyPrefix = 'flowv1::card-1::deliver::0::edited.jpg';
    const { uploads, transport } = recordingFileTransport();

    const run1 = await egressSendFile(db!, transport, {
      runId: 'run-A',
      channel: '#deliveries',
      filePath,
      keyPrefix: sharedKeyPrefix,
    });
    expect(run1.posted).toBe(true);

    // Same card/station/attempt/bytes, DIFFERENT run — a distinct requester.
    const run2 = await egressSendFile(db!, transport, {
      runId: 'run-B',
      channel: '#deliveries',
      filePath,
      keyPrefix: sharedKeyPrefix,
    });

    expect(run2.posted).toBe(true); // must deliver, not skip
    expect(uploads).toHaveLength(2);

    const rows = outboxRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.run_id))).toEqual(new Set(['run-A', 'run-B']));
    // Same idempotency key, distinct run rows — the UNIQUE(run_id, key) scope.
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(1);
  });

  it('still dedups a SAME-run resume with the same key (run scoping does not weaken idempotency)', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const { uploads, transport } = recordingFileTransport();
    const req = { runId: 'run-A', channel: '#deliveries', filePath, keyPrefix: 'flowv1::card-1::deliver::0::edited.jpg' };

    const first = await egressSendFile(db!, transport, req);
    expect(first.posted).toBe(true);

    const resume = await egressSendFile(db!, transport, req);
    expect(resume.posted).toBe(false); // committed within the same run → skip
    expect(uploads).toHaveLength(1);
    expect(outboxRows()).toHaveLength(1);
  });
});

// ===========================================================================
// AC5 — missing/unreadable file → typed diagnosable error, no stored bytes
// ===========================================================================

describe('egressSendFile — missing/unreadable file (AC5/NFR-3)', () => {
  it('rejects with a typed error naming the path, before writing any outbox intent', async () => {
    const missingPath = join(dir, 'does-not-exist.jpg');
    const { uploads, transport } = recordingFileTransport();

    let caught: unknown;
    try {
      await egressSendFile(db!, transport, {
        channel: '#deliveries',
        filePath: missingPath,
        keyPrefix: 'run1::c1::deliver::0::missing.jpg',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    // Diagnosable: the error names the offending path.
    expect((caught as Error).message).toContain(missingPath);
    // No silent success and no stored bytes: nothing was uploaded or written.
    expect(uploads).toHaveLength(0);
    expect(outboxRows()).toHaveLength(0);
  });

  // Amy REJECT: the PRD edge case is "missing/EMPTY" (prd:108 — "hold with a
  // naming error; do not scrap"), and AC5 names it. A zero-byte file at an
  // existing, readable path is neither missing nor unreadable, so a bare
  // readFileSync guard never trips — it would fingerprint the empty buffer and
  // deliver a 0-byte file with no diagnosable signal. The empty half of the edge
  // case must fail exactly like the missing half.
  it('rejects a zero-byte file with a typed error naming the path, with no upload and no outbox intent', async () => {
    const emptyPath = makeFile('', 'empty.jpg'); // exists, readable, but 0 bytes
    const { uploads, transport } = recordingFileTransport();

    let caught: unknown;
    try {
      await egressSendFile(db!, transport, {
        channel: '#deliveries',
        filePath: emptyPath,
        keyPrefix: 'run1::c1::deliver::0::empty.jpg',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(emptyPath);
    // Never delivered, never persisted — no silent 0-byte send.
    expect(uploads).toHaveLength(0);
    expect(outboxRows()).toHaveLength(0);
  });
});

// ===========================================================================
// AC6 — the persisted intent payload carries path/size/fingerprint, NOT bytes
// ===========================================================================

describe('egressSendFile — no file bytes in the outbox payload (AC6/NFR-2)', () => {
  it('persists only the path, size, and content fingerprint — never the file bytes', async () => {
    const filePath = makeFile(FILE_CONTENT);
    const { transport } = recordingFileTransport();

    await egressSendFile(db!, transport, {
      channel: '#deliveries',
      filePath,
      keyPrefix: 'run1::c1::deliver::0::edited.jpg',
    });

    const payload = outboxRows()[0]!.payload_json;
    // The raw bytes NEVER appear in the persisted intent (NFR-2).
    expect(payload).not.toContain(FILE_CONTENT);
    // But the path, byte size, and sha256 fingerprint do.
    expect(payload).toContain(filePath);
    expect(payload).toContain(String(Buffer.byteLength(FILE_CONTENT)));
    expect(payload).toContain(fingerprintOf(filePath));
  });
});

// ===========================================================================
// Transport capability — a transport lacking uploadFile fails diagnosably
// (Context: "must yield a diagnosable error, not a crash")
// ===========================================================================

describe('egressSendFile — transport without uploadFile (WI-597 optional)', () => {
  it('rejects with a diagnosable error (not an uncaught TypeError) when the transport has no uploadFile', async () => {
    const filePath = makeFile(FILE_CONTENT);
    // A text-only transport (the shape a CLI-triggered flow may carry).
    const textOnly: SlackTransport = { post: async () => ({ ts: 'ts' }) };

    let caught: unknown;
    try {
      await egressSendFile(db!, textOnly, {
        channel: '#deliveries',
        filePath,
        keyPrefix: 'run1::c1::deliver::0::edited.jpg',
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/upload/i);
    // No partial delivery: nothing committed.
    const rows = outboxRows();
    if (rows.length > 0) {
      expect(rows[0]!.delivered_at).toBeNull();
    }
  });
});

// ===========================================================================
// AC7 — egressSend gains an optional thread address forwarded to post
//        (FR-7 send-layer half): positive AND negative (no-regression)
// ===========================================================================

describe('egressSend — optional thread address rider (AC7/FR-7)', () => {
  function recordingPostTransport(): { posts: Array<{ channel: string; text: string; threadTs?: string }>; transport: SlackTransport } {
    const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
    const transport: SlackTransport = {
      post: async (req) => {
        posts.push({ channel: req.channel, text: req.text, threadTs: req.threadTs });
        return { ts: `ts-${posts.length}` };
      },
    };
    return { posts, transport };
  }

  it('forwards threadTs to transport.post when provided', async () => {
    const { posts, transport } = recordingPostTransport();

    await egressSend(db!, transport, {
      channel: '#content',
      text: 'delivered: edited.jpg',
      idempotencyKey: 'threaded-1',
      threadTs: THREAD_TS,
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.threadTs).toBe(THREAD_TS);
  });

  it('leaves threadTs undefined on transport.post for an unthreaded send (byte-identical no-regression)', async () => {
    const { posts, transport } = recordingPostTransport();

    await egressSend(db!, transport, {
      channel: '#content',
      text: 'delivered: edited.jpg',
      idempotencyKey: 'unthreaded-1',
    });

    expect(posts[0]!.threadTs).toBeUndefined();
  });
});
