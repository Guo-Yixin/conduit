/**
 * Tests for the kernel<->worker IPC message protocol (WI-465, SPEC §10A,
 * SPEC §4 "Start/Finish transaction", FR-2 / NFR-4).
 *
 * This is the wire contract the worker harness and the event-driven kernel pool
 * exchange over Bun `process.send`. It is PURE types + a parse/serialize +
 * size-bound validator — NO I/O, NO process spawning, NO station logic — so it
 * is independently unit-testable.
 *
 * Core discipline pinned here (the reason the protocol exists):
 *   Large artifacts travel through the filesystem (a card's owned_paths), NEVER
 *   over the IPC channel. So START_WORK carries resolved input *references*
 *   (paths/names), not artifact bytes, and the validator (a) rejects any message
 *   whose serialized size exceeds the declared bound and (b) rejects a START_WORK
 *   that embeds raw artifact content — enforcing filesystem-not-IPC at the
 *   contract level.
 *
 * Contract this file pins for src/worker/ipc-protocol.ts:
 *
 *   // Serialized-size ceiling, in bytes. A small bound — references, not bytes.
 *   export const MAX_IPC_MESSAGE_BYTES: number;
 *
 *   // Discriminated union, keyed on `type`.
 *   export interface StartWorkMessage {
 *     type: 'START_WORK';
 *     cardId: string;
 *     station: string;
 *     // Resolved input references — paths/names that point at owned_paths on
 *     // disk. NEVER inline artifact bytes.
 *     inputRefs: string[];
 *   }
 *   export interface MarkDoneMessage {
 *     type: 'MARK_DONE';
 *     cardId: string;
 *     station: string;
 *     attempt: number;
 *     // The result outcome the worker reports back for the DONE transaction.
 *     outcome: 'success' | 'rework' | 'scrap';
 *   }
 *   export interface HeartbeatMessage {
 *     type: 'HEARTBEAT';
 *     cardId: string;
 *     station: string;
 *   }
 *   export type WorkerMessage =
 *     | StartWorkMessage | MarkDoneMessage | HeartbeatMessage;
 *
 *   // Serialize a typed message to its wire string. Pure.
 *   export function serializeWorkerMessage(msg: WorkerMessage): string;
 *
 *   // Parse a wire string back to a typed message. NEVER throws: a malformed
 *   // payload, an oversized payload, or an embedded-artifact START_WORK all
 *   // return { ok: false; error }. On success returns the narrowed message.
 *   export type ParseResult =
 *     | { ok: true; message: WorkerMessage }
 *     | { ok: false; error: string };
 *   export function parseWorkerMessage(raw: string): ParseResult;
 *
 * NOTE for B.A. (impl): match the dispatch vocabulary — cardId/station/workerId
 * from ClaimRequest (src/dispatch/claim.ts:25) and action.station/action.cardId
 * from executeStation (src/controller/executor.ts:407). Keep it minimal.
 */

import { describe, it, expect } from 'bun:test';
import {
  MAX_IPC_MESSAGE_BYTES,
  MAX_STDERR_TAIL,
  sanitizeStderrTail,
  serializeWorkerMessage,
  parseWorkerMessage,
  type WorkerMessage,
  type StartWorkMessage,
  type MarkDoneMessage,
  type HeartbeatMessage,
} from './ipc-protocol';

// ---------------------------------------------------------------------------
// Round-trip: well-formed messages serialize and parse back to the same object
// ---------------------------------------------------------------------------

describe('parseWorkerMessage — well-formed round-trips (AC2)', () => {
  it('round-trips a START_WORK carrying input references (not bytes)', () => {
    const msg: StartWorkMessage = {
      type: 'START_WORK',
      cardId: 'card-42',
      station: 'draft',
      attempt: 0,
      inputRefs: ['inputs/brief.md', 'inputs/style.json'],
    };

    const parsed = parseWorkerMessage(serializeWorkerMessage(msg));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.message).toEqual(msg);
    // Discriminant is preserved so callers can narrow.
    expect(parsed.message.type).toBe('START_WORK');
  });

  it('round-trips a MARK_DONE with attempt and result outcome', () => {
    const msg: MarkDoneMessage = {
      type: 'MARK_DONE',
      cardId: 'card-42',
      station: 'draft',
      attempt: 2,
      outcome: 'success',
    };

    const parsed = parseWorkerMessage(serializeWorkerMessage(msg));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.message).toEqual(msg);
    if (parsed.message.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(parsed.message.attempt).toBe(2);
    expect(parsed.message.outcome).toBe('success');
  });

  it('round-trips a MARK_DONE carrying token usage (worker spend attribution)', () => {
    const msg: MarkDoneMessage = {
      type: 'MARK_DONE',
      cardId: 'card-42',
      station: 'draft',
      attempt: 1,
      outcome: 'success',
      usage: { tokens: 1234, cost: 0.0042 },
    };

    const parsed = parseWorkerMessage(serializeWorkerMessage(msg));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.message).toEqual(msg);
    if (parsed.message.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(parsed.message.usage?.tokens).toBe(1234);
  });

  it("round-trips a MARK_DONE('failed') carrying failure detail (the original deterministic failure-reporting work)", () => {
    const msg: MarkDoneMessage = {
      type: 'MARK_DONE',
      cardId: 'card-42',
      station: 'encode',
      attempt: 1,
      outcome: 'failed',
      usage: { tokens: 0 },
      failure: { exitCode: 137, timedOut: true, stderrTail: 'ffmpeg: killed' },
    };

    const parsed = parseWorkerMessage(serializeWorkerMessage(msg));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.message).toEqual(msg);
    if (parsed.message.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(parsed.message.failure?.exitCode).toBe(137);
    expect(parsed.message.failure?.timedOut).toBe(true);
  });

  it("rejects a MARK_DONE('failed') that omits the failure detail (the journal needs the exit code)", () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({
        type: 'MARK_DONE',
        cardId: 'c1',
        station: 's',
        attempt: 0,
        outcome: 'failed',
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected rejection');
    expect(parsed.error).toContain('requires failure detail');
  });

  it('sanitizeStderrTail strips control characters and slices to the cap (log-injection guard)', () => {
    expect(sanitizeStderrTail('\x1b[31mboom\nline2\x07\x00end')).toBe('[31mboom line2 end');
    // Sanitize-then-slice: control chars never eat the diagnostic budget.
    expect(sanitizeStderrTail(`${'\n'.repeat(400)}real error`, 10)).toBe('real error');
  });

  it("rejects failure detail on any outcome other than 'failed' (no ambiguous verdicts)", () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({
        type: 'MARK_DONE',
        cardId: 'c1',
        station: 's',
        attempt: 0,
        outcome: 'scrap',
        failure: { exitCode: 1 },
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected rejection');
    expect(parsed.error).toContain('failed');
  });

  it('rejects a failure.stderrTail over the codec cap (diagnostic tail, not a byte channel)', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({
        type: 'MARK_DONE',
        cardId: 'c1',
        station: 's',
        attempt: 0,
        outcome: 'failed',
        failure: { exitCode: 1, stderrTail: 'x'.repeat(MAX_STDERR_TAIL + 1) },
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects a failure record with unknown fields or a non-integer exitCode', () => {
    for (const failure of [
      { exitCode: 1, smuggled: 'bytes' },
      { exitCode: 1.5 },
      { exitCode: 'one' },
    ]) {
      const parsed = parseWorkerMessage(
        JSON.stringify({
          type: 'MARK_DONE', cardId: 'c1', station: 's', attempt: 0, outcome: 'failed', failure,
        }),
      );
      expect(parsed.ok).toBe(false);
    }
  });

  it('rejects a MARK_DONE whose usage.tokens is negative', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({
        type: 'MARK_DONE',
        cardId: 'c1',
        station: 's1',
        attempt: 0,
        outcome: 'success',
        usage: { tokens: -5 },
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/usage\.tokens/i);
  });

  it('rejects a MARK_DONE whose usage carries an unexpected field', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({
        type: 'MARK_DONE',
        cardId: 'c1',
        station: 's1',
        attempt: 0,
        outcome: 'success',
        usage: { tokens: 10, smuggled: 'bytes' },
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/usage/i);
  });

  it('rejects a START_WORK whose attempt is not an integer', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({ type: 'START_WORK', cardId: 'c1', station: 's1', attempt: 1.5, inputRefs: [] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/attempt/i);
  });

  it('round-trips a START_WORK carrying reworkCount (PATCH 2 pool env source)', () => {
    const msg: StartWorkMessage = {
      type: 'START_WORK',
      cardId: 'card-42',
      station: 'gen',
      attempt: 2,
      reworkCount: 3,
      inputRefs: [],
    };

    const parsed = parseWorkerMessage(serializeWorkerMessage(msg));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.message).toEqual(msg);
    if (parsed.message.type !== 'START_WORK') throw new Error('wrong variant');
    expect(parsed.message.reworkCount).toBe(3);
  });

  it('omits reworkCount on parse when absent (optional field, not defaulted into the message)', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({ type: 'START_WORK', cardId: 'c1', station: 's1', attempt: 0, inputRefs: [] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    if (parsed.message.type !== 'START_WORK') throw new Error('wrong variant');
    expect(parsed.message.reworkCount).toBeUndefined();
  });

  it('rejects a START_WORK whose reworkCount is negative or non-integer', () => {
    for (const bad of [-1, 2.5]) {
      const parsed = parseWorkerMessage(
        JSON.stringify({ type: 'START_WORK', cardId: 'c1', station: 's1', attempt: 0, reworkCount: bad, inputRefs: [] }),
      );
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('expected failure');
      expect(parsed.error).toMatch(/reworkCount/i);
    }
  });

  it('round-trips a HEARTBEAT', () => {
    const msg: HeartbeatMessage = {
      type: 'HEARTBEAT',
      cardId: 'card-42',
      station: 'draft',
    };

    const parsed = parseWorkerMessage(serializeWorkerMessage(msg));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.message).toEqual(msg);
    expect(parsed.message.type).toBe('HEARTBEAT');
  });

  it.each([
    ['success' as const],
    ['rework' as const],
    ['scrap' as const],
  ])('accepts MARK_DONE outcome=%s', (outcome) => {
    const msg: MarkDoneMessage = {
      type: 'MARK_DONE',
      cardId: 'c1',
      station: 's1',
      attempt: 0,
      outcome,
    };

    const parsed = parseWorkerMessage(serializeWorkerMessage(msg));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    if (parsed.message.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(parsed.message.outcome).toBe(outcome);
  });
});

// ---------------------------------------------------------------------------
// Malformed payloads — return a parse error, never throw, never partial (AC3)
// ---------------------------------------------------------------------------

describe('parseWorkerMessage — malformed payloads return errors, never throw (AC3)', () => {
  it('rejects a payload that is not valid JSON', () => {
    const parsed = parseWorkerMessage('{not json');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toBeTruthy();
  });

  it('rejects a payload missing the type discriminator', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({ cardId: 'c1', station: 's1' }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/type/i);
  });

  it('rejects an unknown type discriminator', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({ type: 'EXPLODE', cardId: 'c1', station: 's1' }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/EXPLODE|type/i);
  });

  it('rejects a START_WORK with a wrong field type (inputRefs not an array)', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({
        type: 'START_WORK',
        cardId: 'c1',
        station: 's1',
        attempt: 0,
        inputRefs: 'inputs/brief.md',
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/inputRefs/i);
  });

  it('rejects a START_WORK missing a required field (cardId)', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({ type: 'START_WORK', station: 's1', inputRefs: [] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/cardId/i);
  });

  it('rejects a MARK_DONE with a non-numeric attempt', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({
        type: 'MARK_DONE',
        cardId: 'c1',
        station: 's1',
        attempt: 'two',
        outcome: 'success',
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/attempt/i);
  });

  it('rejects a MARK_DONE with an outcome outside the allowed set', () => {
    const parsed = parseWorkerMessage(
      JSON.stringify({
        type: 'MARK_DONE',
        cardId: 'c1',
        station: 's1',
        attempt: 0,
        outcome: 'maybe',
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/outcome/i);
  });

  it('does not throw on any malformed input (returns a result object)', () => {
    const inputs = [
      '',
      'null',
      '[]',
      '42',
      '"a string"',
      '{"type":null}',
      '{not json',
    ];
    for (const raw of inputs) {
      // The contract is "never throw" — calling must always return a result.
      const parsed = parseWorkerMessage(raw);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error(`expected failure for input: ${raw}`);
      expect(parsed.error).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Size bound — oversized messages rejected with a limit-naming error (AC4, NFR-4)
// ---------------------------------------------------------------------------

describe('parseWorkerMessage — size bound enforces references-not-bytes (AC4, NFR-4)', () => {
  it('declares a positive byte ceiling', () => {
    expect(MAX_IPC_MESSAGE_BYTES).toBeGreaterThan(0);
  });

  it('rejects a serialized message exceeding the byte bound', () => {
    // A structurally-valid HEARTBEAT whose station name is padded past the
    // ceiling. The shape is fine; only the SIZE is the violation.
    const oversized = JSON.stringify({
      type: 'HEARTBEAT',
      cardId: 'c1',
      station: 'x'.repeat(MAX_IPC_MESSAGE_BYTES + 100),
    });
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(MAX_IPC_MESSAGE_BYTES);

    const parsed = parseWorkerMessage(oversized);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/size/i);
  });

  it('size-violation error names the byte limit', () => {
    const oversized = JSON.stringify({
      type: 'HEARTBEAT',
      cardId: 'c1',
      station: 'x'.repeat(MAX_IPC_MESSAGE_BYTES + 100),
    });

    const parsed = parseWorkerMessage(oversized);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    // The limit must appear in the message so an operator sees the ceiling.
    expect(parsed.error).toContain(String(MAX_IPC_MESSAGE_BYTES));
  });

  it('accepts a message right at/under the bound', () => {
    const msg: HeartbeatMessage = {
      type: 'HEARTBEAT',
      cardId: 'c1',
      station: 's1',
    };
    const wire = serializeWorkerMessage(msg);
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(MAX_IPC_MESSAGE_BYTES);

    const parsed = parseWorkerMessage(wire);
    expect(parsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Embedded-artifact rejection — filesystem-not-IPC at the contract level (AC5)
// ---------------------------------------------------------------------------

describe('parseWorkerMessage — START_WORK rejects embedded artifact content (AC5)', () => {
  it('rejects a START_WORK carrying an unknown inline-blob field', () => {
    // A blob field is not part of the contract — START_WORK carries references,
    // not bytes. An unknown field smuggling artifact content must be rejected
    // even when the message is under the size bound.
    const smuggled = JSON.stringify({
      type: 'START_WORK',
      cardId: 'c1',
      station: 's1',
      attempt: 0,
      inputRefs: ['inputs/brief.md'],
      artifactBytes: 'PD94bWwgdmVyc2lvbj0i', // base64-looking inline blob
    });
    expect(Buffer.byteLength(smuggled, 'utf8')).toBeLessThanOrEqual(MAX_IPC_MESSAGE_BYTES);

    const parsed = parseWorkerMessage(smuggled);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/artifact|blob|unexpected|unknown field|inputRefs/i);
  });

  it('rejects an inputRef that inlines artifact bytes instead of a path', () => {
    // A data: URI is artifact content masquerading as a reference. References
    // must point at owned_paths on disk, not embed the payload inline.
    const dataUri =
      'data:image/png;base64,' + 'A'.repeat(2048);
    const inlined = JSON.stringify({
      type: 'START_WORK',
      cardId: 'c1',
      station: 's1',
      attempt: 0,
      inputRefs: [dataUri],
    });

    const parsed = parseWorkerMessage(inlined);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.error).toMatch(/artifact|inline|data:|reference|inputRefs/i);
  });

  it('accepts a START_WORK whose inputRefs are plain on-disk paths', () => {
    const ok: StartWorkMessage = {
      type: 'START_WORK',
      cardId: 'c1',
      station: 's1',
      attempt: 0,
      inputRefs: ['inputs/brief.md', 'shared/style.json'],
    };

    const parsed = parseWorkerMessage(serializeWorkerMessage(ok));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.message).toEqual(ok);
  });
});

// ---------------------------------------------------------------------------
// serializeWorkerMessage is the inverse of parseWorkerMessage for every variant
// ---------------------------------------------------------------------------

describe('serializeWorkerMessage — inverse of parse for all variants (AC1)', () => {
  const cases: WorkerMessage[] = [
    { type: 'START_WORK', cardId: 'c1', station: 's1', attempt: 0, inputRefs: ['a.md'] },
    { type: 'MARK_DONE', cardId: 'c1', station: 's1', attempt: 3, outcome: 'rework' },
    { type: 'HEARTBEAT', cardId: 'c1', station: 's1' },
  ];

  it.each(cases.map((m) => [m.type, m] as const))(
    'serialize→parse is identity for %s',
    (_type, msg) => {
      const parsed = parseWorkerMessage(serializeWorkerMessage(msg));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('expected ok');
      expect(parsed.message).toEqual(msg);
    },
  );
});
