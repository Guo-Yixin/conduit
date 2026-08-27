/**
 * Tests for the per-call image payload guard (WI-420, FR-9, Resolved Q3).
 *
 * A LIGHT guard that catches a single pathological image input before it becomes
 * an opaque provider rejection: a configurable max byte size PER IMAGE and a max
 * image COUNT per call, with sensible defaults near the provider's documented
 * limits. Over-limit is rejected with a clear KERNEL error (before the gateway).
 *
 * Scope boundary (item Context): WI-420 owns SIZE and COUNT limits ONLY. Format
 * detection / "can't detect media type → throw" is loadImageInput's job (WI-413)
 * — AC4 here is the composition guarantee that an undetectable format surfaces a
 * clear kernel error upstream (loadImageInput), not the guard. The max-COUNT
 * limit must AGREE with WI-414's load-time bounded-list check (the same
 * configured count, MAX_IMAGE_INPUTS_PER_CALL).
 *
 * ── Contract this file pins for src/worker/image-input.ts ──────────────────
 *
 *   // Sensible default per-image byte ceiling, near provider docs (e.g. ~20 MB).
 *   export const MAX_IMAGE_BYTES: number;
 *
 *   // Throws a clear kernel Error when any image exceeds maxBytes (names the
 *   // offending image + the limit) or when images.length exceeds maxCount
 *   // (states the count + the limit). Returns void when within both limits.
 *   // Defaults: maxBytes = MAX_IMAGE_BYTES, maxCount = MAX_IMAGE_INPUTS_PER_CALL.
 *   export function assertImagePayloadWithinLimits(
 *     images: ImageInput[],
 *     limits?: { maxBytes?: number; maxCount?: number },
 *   ): void;
 *
 * The guard read is structural so this file type-checks against the current
 * module while B.A. adds the export; an absent guard throws "is not a function"
 * — a crisp RED. The guard's input is plain ImageInput data (not a mock).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadImageInput, type ImageInput } from './image-input';
import * as imageInputModule from './image-input';
import { MAX_IMAGE_INPUTS_PER_CALL } from '../flow/load';

// ---------------------------------------------------------------------------
// Target API (WI-420), read structurally so this file compiles against the
// current image-input module (where the exports do not yet exist).
// ---------------------------------------------------------------------------
type Limits = { maxBytes?: number; maxCount?: number };
type GuardFn = (images: ImageInput[], limits?: Limits) => void;

const assertImagePayloadWithinLimits = (
  imageInputModule as { assertImagePayloadWithinLimits?: GuardFn }
).assertImagePayloadWithinLimits as GuardFn;

const MAX_IMAGE_BYTES: unknown = (imageInputModule as { MAX_IMAGE_BYTES?: unknown }).MAX_IMAGE_BYTES;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A plain ImageInput with a controllable byte length and path (test data). */
function img(path: string, byteLength: number): ImageInput {
  return { path, bytes: new Uint8Array(byteLength), mediaType: 'image/png' };
}

/** Capture the message of the error thrown by `fn`, or '' if it did not throw. */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

// ===========================================================================
// AC1 — an image larger than the max-bytes limit is rejected with a clear kernel
//        error naming the offending image AND the limit.
// ===========================================================================

describe('assertImagePayloadWithinLimits — oversized image rejected (AC1)', () => {
  it('throws a clear error naming the offending image and the byte limit', () => {
    const images = [img('thumb.png', 50), img('frames/huge.png', 500)];
    const run = () => assertImagePayloadWithinLimits(images, { maxBytes: 100 });

    expect(run).toThrow();
    const message = thrownMessage(run);
    // Names the OFFENDING image (the 500-byte one), not the within-limit one.
    expect(message).toContain('frames/huge.png');
    expect(message).not.toContain('thumb.png');
    // States the limit.
    expect(message).toContain('100');
  });

  it('rejects an image at the default MAX_IMAGE_BYTES ceiling without an explicit limit', () => {
    // No explicit maxBytes → the default applies. Construct an image one byte over.
    const over = img('over.png', (MAX_IMAGE_BYTES as number) + 1);
    expect(() => assertImagePayloadWithinLimits([over])).toThrow(/over\.png/);
  });
});

// ===========================================================================
// AC2 — more images than the max-count limit is rejected with a clear kernel
//        error stating the count and the limit. The default count AGREES with
//        WI-414's MAX_IMAGE_INPUTS_PER_CALL (same configured count).
// ===========================================================================

describe('assertImagePayloadWithinLimits — too many images rejected (AC2)', () => {
  it('rejects more images than the default max-count, naming the count and the limit', () => {
    const tooMany = Array.from({ length: MAX_IMAGE_INPUTS_PER_CALL + 1 }, (_, i) => img(`i${i}.png`, 10));
    const run = () => assertImagePayloadWithinLimits(tooMany);

    expect(run).toThrow();
    const message = thrownMessage(run);
    expect(message).toContain(String(MAX_IMAGE_INPUTS_PER_CALL + 1)); // the count
    expect(message).toContain(String(MAX_IMAGE_INPUTS_PER_CALL)); // the limit
  });

  it('accepts exactly MAX_IMAGE_INPUTS_PER_CALL images (boundary — agrees with WI-414)', () => {
    const atLimit = Array.from({ length: MAX_IMAGE_INPUTS_PER_CALL }, (_, i) => img(`i${i}.png`, 10));
    expect(() => assertImagePayloadWithinLimits(atLimit)).not.toThrow();
  });
});

// ===========================================================================
// AC3 — sensible defaults near provider limits, and both limits are configurable.
// ===========================================================================

describe('assertImagePayloadWithinLimits — sensible defaults and configurable limits (AC3)', () => {
  it('exports MAX_IMAGE_BYTES as a positive integer near the provider documented limit', () => {
    expect(typeof MAX_IMAGE_BYTES).toBe('number');
    expect(Number.isInteger(MAX_IMAGE_BYTES as number)).toBe(true);
    // "Near provider limits": at least 1 MB and no larger than 64 MB — rules out
    // absurd defaults (a few bytes, or effectively unbounded) without pinning a
    // single provider's exact figure.
    expect(MAX_IMAGE_BYTES as number).toBeGreaterThanOrEqual(1_000_000);
    expect(MAX_IMAGE_BYTES as number).toBeLessThanOrEqual(64_000_000);
  });

  it('honours a configurable maxBytes (rejects under-default but over-custom)', () => {
    const image = img('mid.png', 5_000);
    // Within the default ceiling → passes when unconfigured...
    expect(() => assertImagePayloadWithinLimits([image])).not.toThrow();
    // ...but a tighter custom limit rejects it.
    expect(() => assertImagePayloadWithinLimits([image], { maxBytes: 1_000 })).toThrow(/mid\.png/);
  });

  it('honours a configurable maxCount (independent of the default)', () => {
    const three = Array.from({ length: 3 }, (_, i) => img(`i${i}.png`, 10));
    expect(() => assertImagePayloadWithinLimits(three, { maxCount: 2 })).toThrow();
    expect(() => assertImagePayloadWithinLimits(three, { maxCount: 5 })).not.toThrow();
  });
});

// ===========================================================================
// AC4 — an unsupported/undetectable image format surfaces a clear KERNEL error
//        rather than an opaque provider rejection. Per the item Context, format
//        rejection is owned UPSTREAM by loadImageInput (WI-413); the guard
//        composes with it. This verifies the boundary partner still holds.
// ===========================================================================

describe('undetectable image format surfaces a clear kernel error upstream (AC4 boundary)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it('loadImageInput rejects a non-image file with a clear, non-ENOENT kernel error (not a provider 400)', () => {
    const root = mkdtempSync(join(tmpdir(), 'conduit-img-guard-'));
    dirs.push(root);
    writeFileSync(join(root, 'notes.txt'), 'this is plainly not an image', 'utf-8');

    const run = () => loadImageInput(root, 'notes.txt');
    expect(run).toThrow();
    const message = thrownMessage(run);
    // A clear kernel error naming the file, surfaced before any gateway dispatch.
    expect(message).toContain('notes.txt');
    expect(message).not.toMatch(/ENOENT/);
  });
});

// ===========================================================================
// AC5 / NFR-1 — images within both limits pass unchanged; a text-only (no image)
//        call is unaffected. (The per-run token budget remains the cost ceiling;
//        this guard only catches a single pathological input.)
// ===========================================================================

describe('assertImagePayloadWithinLimits — within-limit and text-only calls pass (AC5 / NFR-1)', () => {
  it('passes a call whose images are within both the byte and count limits', () => {
    const images = [img('a.png', 1_000), img('b.png', 2_000)];
    expect(() => assertImagePayloadWithinLimits(images)).not.toThrow();
  });

  it('passes a text-only call (no images) unchanged — empty list is never a violation', () => {
    expect(() => assertImagePayloadWithinLimits([])).not.toThrow();
  });
});
