// Kernel<->worker IPC message protocol (SPEC §10A, FR-2/NFR-4).
// Pure functions only — no I/O, no process spawning.

// Serialized-size ceiling: references only, never artifact bytes.
export const MAX_IPC_MESSAGE_BYTES = 64 * 1024; // 64 KiB

export interface StartWorkMessage {
  type: 'START_WORK';
  cardId: string;
  station: string;
  /**
   * The card's current execution attempt. Echoed back verbatim in MARK_DONE so
   * the kernel's idempotency guard can drop a stale completion from a worker that
   * was reclaimed and re-dispatched (a duplicate carries the prior attempt).
   */
  attempt: number;
  /**
   * The card's rework count, surfaced to a pooled deterministic station as
   * CONDUIT_REWORK_COUNT (market-flow parity PATCH 2). Optional: absent → the
   * consumer coalesces to 0, so an old/synthetic message without it is safe. The
   * production dispatch path always populates it, so a pool-eligible deterministic
   * station sees the same env it would on the synchronous path.
   */
  reworkCount?: number;
  inputRefs: string[];
}

/** Token/cost spend a worker attributes to its station run (NFR-4: counts only, never bytes). */
export interface WorkerUsage {
  tokens: number;
  cost?: number;
}

/**
 * Diagnostic detail for a 'failed' outcome (the original deterministic failure-reporting work / the pre-public deterministic failure-reporting review): what
 * the command did, so the kernel's retry journal and eventual scrap reason can
 * name the failure. Counts and short text only — never artifact bytes (NFR-4);
 * the stderr tail is hard-capped at MAX_STDERR_TAIL chars by the codec.
 */
export interface WorkerFailureDetail {
  exitCode: number;
  timedOut?: boolean;
  stderrTail?: string;
}

/** Codec cap for WorkerFailureDetail.stderrTail (diagnostic tail, not a byte channel). */
export const MAX_STDERR_TAIL = 500;

/**
 * Collapse control characters (C0/C1, DEL — newlines, ANSI escape leads, bells)
 * to single spaces and take the LAST `max` chars. Failure tails end up inside
 * human-readable reason strings, journal attributes, and card_log rows; raw
 * control characters there are a log-injection vector (a hostile command could
 * forge extra "lines" or corrupt terminal/UI rendering). Sanitize-then-slice
 * so control chars never eat the diagnostic budget either.
 */
export function sanitizeStderrTail(text: string, max: number = MAX_STDERR_TAIL): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(-max);
}

export interface MarkDoneMessage {
  type: 'MARK_DONE';
  cardId: string;
  station: string;
  attempt: number;
  /**
   * 'failed' (the original deterministic failure-reporting work): the deterministic command exited nonzero / timed out.
   * Unlike 'scrap' (a terminal verdict), 'failed' asks the KERNEL to apply the
   * attempt-cap accounting — retry below per_card.max_execution_attempts,
   * named scrap at it — so pooled stations get the same flaky-command
   * tolerance as the synchronous path instead of scrap-on-first-failure.
   */
  outcome: 'success' | 'rework' | 'scrap' | 'failed';
  /**
   * Model spend the worker incurred, folded into the run/wave token budget by the
   * kernel. Absent (or 0) for deterministic stations, which never call the model.
   */
  usage?: WorkerUsage;
  /** Present iff outcome === 'failed' — the codec rejects any other pairing. */
  failure?: WorkerFailureDetail;
}

export interface HeartbeatMessage {
  type: 'HEARTBEAT';
  cardId: string;
  station: string;
}

export type WorkerMessage = StartWorkMessage | MarkDoneMessage | HeartbeatMessage;

export type ParseResult =
  | { ok: true; message: WorkerMessage }
  | { ok: false; error: string };

export function serializeWorkerMessage(msg: WorkerMessage): string {
  return JSON.stringify(msg);
}

export function parseWorkerMessage(raw: string): ParseResult {
  try {
    const byteLen = Buffer.byteLength(raw, 'utf8');
    if (byteLen > MAX_IPC_MESSAGE_BYTES) {
      return {
        ok: false,
        error: `Message size ${byteLen} exceeds limit of ${MAX_IPC_MESSAGE_BYTES} bytes`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Invalid JSON payload' };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Payload must be a JSON object' };
    }

    const obj = parsed as Record<string, unknown>;

    if (!('type' in obj) || typeof obj['type'] !== 'string') {
      return { ok: false, error: 'Missing or invalid type discriminator' };
    }

    const type = obj['type'];

    if (type === 'START_WORK') {
      return validateStartWork(obj);
    } else if (type === 'MARK_DONE') {
      return validateMarkDone(obj);
    } else if (type === 'HEARTBEAT') {
      return validateHeartbeat(obj);
    } else {
      return { ok: false, error: `Unknown type discriminator: ${type}` };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function validateStartWork(obj: Record<string, unknown>): ParseResult {
  if (typeof obj['cardId'] !== 'string' || !obj['cardId']) {
    return { ok: false, error: 'START_WORK: missing or invalid cardId' };
  }
  if (typeof obj['station'] !== 'string' || !obj['station']) {
    return { ok: false, error: 'START_WORK: missing or invalid station' };
  }
  if (
    typeof obj['attempt'] !== 'number' ||
    !Number.isInteger(obj['attempt']) ||
    (obj['attempt'] as number) < 0
  ) {
    return { ok: false, error: 'START_WORK: attempt must be a non-negative integer' };
  }
  // reworkCount is optional; when present it must be a non-negative integer.
  if (
    obj['reworkCount'] !== undefined &&
    (typeof obj['reworkCount'] !== 'number' ||
      !Number.isInteger(obj['reworkCount']) ||
      (obj['reworkCount'] as number) < 0)
  ) {
    return { ok: false, error: 'START_WORK: reworkCount must be a non-negative integer' };
  }
  if (!Array.isArray(obj['inputRefs'])) {
    return { ok: false, error: 'START_WORK: inputRefs must be an array' };
  }

  const inputRefs = obj['inputRefs'] as unknown[];
  for (const ref of inputRefs) {
    if (typeof ref !== 'string') {
      return { ok: false, error: 'START_WORK: inputRefs must be strings' };
    }
    // Reject data: and blob: URIs — artifact bytes masquerading as references
    const lower = (ref as string).toLowerCase();
    if (lower.startsWith('data:') || lower.startsWith('blob:')) {
      return {
        ok: false,
        error: 'START_WORK: inputRefs must be filesystem paths, not inline data: or blob: artifact URIs',
      };
    }
  }

  // Reject unknown fields — no smuggling artifact bytes via extra properties
  const allowed = new Set(['type', 'cardId', 'station', 'attempt', 'reworkCount', 'inputRefs']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        error: `START_WORK: unexpected field "${key}" — artifact bytes must go through owned_paths, not IPC`,
      };
    }
  }

  return {
    ok: true,
    message: {
      type: 'START_WORK',
      cardId: obj['cardId'] as string,
      station: obj['station'] as string,
      attempt: obj['attempt'] as number,
      ...(obj['reworkCount'] !== undefined ? { reworkCount: obj['reworkCount'] as number } : {}),
      inputRefs: obj['inputRefs'] as string[],
    },
  };
}

const MARK_DONE_OUTCOMES = new Set(['success', 'rework', 'scrap', 'failed']);

function validateMarkDone(obj: Record<string, unknown>): ParseResult {
  if (typeof obj['cardId'] !== 'string' || !obj['cardId']) {
    return { ok: false, error: 'MARK_DONE: missing or invalid cardId' };
  }
  if (typeof obj['station'] !== 'string' || !obj['station']) {
    return { ok: false, error: 'MARK_DONE: missing or invalid station' };
  }
  if (
    typeof obj['attempt'] !== 'number' ||
    !Number.isInteger(obj['attempt']) ||
    (obj['attempt'] as number) < 0
  ) {
    return { ok: false, error: 'MARK_DONE: attempt must be a non-negative integer' };
  }
  if (typeof obj['outcome'] !== 'string' || !MARK_DONE_OUTCOMES.has(obj['outcome'] as string)) {
    return {
      ok: false,
      error: `MARK_DONE: outcome must be one of success|rework|scrap|failed, got "${obj['outcome']}"`,
    };
  }

  // Optional usage: a typed counts-only record. Validated strictly so a worker
  // cannot fold an arbitrary object (or smuggle bytes) into the budget surface.
  let usage: WorkerUsage | undefined;
  if ('usage' in obj && obj['usage'] !== undefined) {
    const raw = obj['usage'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'MARK_DONE: usage must be an object' };
    }
    const u = raw as Record<string, unknown>;
    if (typeof u['tokens'] !== 'number' || !Number.isFinite(u['tokens']) || (u['tokens'] as number) < 0) {
      return { ok: false, error: 'MARK_DONE: usage.tokens must be a non-negative number' };
    }
    if ('cost' in u && u['cost'] !== undefined) {
      if (typeof u['cost'] !== 'number' || !Number.isFinite(u['cost']) || (u['cost'] as number) < 0) {
        return { ok: false, error: 'MARK_DONE: usage.cost must be a non-negative number' };
      }
    }
    const usageAllowed = new Set(['tokens', 'cost']);
    for (const key of Object.keys(u)) {
      if (!usageAllowed.has(key)) {
        return { ok: false, error: `MARK_DONE: usage has unexpected field "${key}"` };
      }
    }
    usage = { tokens: u['tokens'] as number };
    if (u['cost'] !== undefined) usage.cost = u['cost'] as number;
  }

  // Failure detail (the original deterministic failure-reporting work): REQUIRED on a 'failed' outcome (the kernel's
  // journal and scrap reasons need the exit code), valid ONLY there, and
  // validated strictly — a bounded diagnostic record, never a byte channel.
  if (obj['outcome'] === 'failed' && (!('failure' in obj) || obj['failure'] === undefined)) {
    return { ok: false, error: "MARK_DONE: outcome 'failed' requires failure detail (exitCode at minimum)" };
  }
  let failure: WorkerFailureDetail | undefined;
  if ('failure' in obj && obj['failure'] !== undefined) {
    if (obj['outcome'] !== 'failed') {
      return { ok: false, error: `MARK_DONE: failure detail is only valid with outcome "failed", got "${obj['outcome']}"` };
    }
    const raw = obj['failure'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'MARK_DONE: failure must be an object' };
    }
    const f = raw as Record<string, unknown>;
    if (typeof f['exitCode'] !== 'number' || !Number.isInteger(f['exitCode'])) {
      return { ok: false, error: 'MARK_DONE: failure.exitCode must be an integer' };
    }
    if ('timedOut' in f && f['timedOut'] !== undefined && typeof f['timedOut'] !== 'boolean') {
      return { ok: false, error: 'MARK_DONE: failure.timedOut must be a boolean' };
    }
    if ('stderrTail' in f && f['stderrTail'] !== undefined) {
      if (typeof f['stderrTail'] !== 'string') {
        return { ok: false, error: 'MARK_DONE: failure.stderrTail must be a string' };
      }
      if ((f['stderrTail'] as string).length > MAX_STDERR_TAIL) {
        return { ok: false, error: `MARK_DONE: failure.stderrTail exceeds ${MAX_STDERR_TAIL} chars — a diagnostic tail, not a byte channel` };
      }
    }
    const failureAllowed = new Set(['exitCode', 'timedOut', 'stderrTail']);
    for (const key of Object.keys(f)) {
      if (!failureAllowed.has(key)) {
        return { ok: false, error: `MARK_DONE: failure has unexpected field "${key}"` };
      }
    }
    failure = { exitCode: f['exitCode'] as number };
    if (f['timedOut'] !== undefined) failure.timedOut = f['timedOut'] as boolean;
    if (f['stderrTail'] !== undefined) failure.stderrTail = f['stderrTail'] as string;
  }

  // Reject unknown fields — no smuggling artifact bytes via extra properties
  const allowed = new Set(['type', 'cardId', 'station', 'attempt', 'outcome', 'usage', 'failure']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        error: `MARK_DONE: unexpected field "${key}" — artifact bytes must go through owned_paths, not IPC`,
      };
    }
  }

  const message: MarkDoneMessage = {
    type: 'MARK_DONE',
    cardId: obj['cardId'] as string,
    station: obj['station'] as string,
    attempt: obj['attempt'] as number,
    outcome: obj['outcome'] as 'success' | 'rework' | 'scrap' | 'failed',
  };
  if (usage !== undefined) message.usage = usage;
  if (failure !== undefined) message.failure = failure;

  return { ok: true, message };
}

function validateHeartbeat(obj: Record<string, unknown>): ParseResult {
  if (typeof obj['cardId'] !== 'string' || !obj['cardId']) {
    return { ok: false, error: 'HEARTBEAT: missing or invalid cardId' };
  }
  if (typeof obj['station'] !== 'string' || !obj['station']) {
    return { ok: false, error: 'HEARTBEAT: missing or invalid station' };
  }

  // Reject unknown fields — no smuggling artifact bytes via extra properties
  const allowed = new Set(['type', 'cardId', 'station']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        error: `HEARTBEAT: unexpected field "${key}" — artifact bytes must go through owned_paths, not IPC`,
      };
    }
  }

  return {
    ok: true,
    message: {
      type: 'HEARTBEAT',
      cardId: obj['cardId'] as string,
      station: obj['station'] as string,
    },
  };
}
