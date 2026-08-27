/**
 * Tests for folding image-input bytes into the checkpoint binding stamp (WI-417).
 *
 * FR-4 / SPEC §10 top risk. A station's binding stamp must fold in its image
 * inputs on the SAME footing as its text inputs, so that:
 *   - an edited image invalidates the checkpoint  → re-run on resume, and
 *   - a byte-identical image leaves the stamp intact → skip-on-resume permitted.
 * This item provides the reusable image-hashing helper colocated with the
 * image-input module (WI-413, src/worker/image-input.ts); the executor wiring
 * that pushes these hashes into inputArtifactHashes is WI-419.
 *
 * ── Contract this file pins for src/worker/image-input.ts ──────────────────
 *
 *   // One input-hash contribution per image, computed from the image BYTES with
 *   // the SAME digest discipline the executor uses for text inputs:
 *   //   createHash('sha256').update(bytes).digest('hex')   (src/controller/executor.ts ~729-748)
 *   // Order is preserved (one hex per image, in input order); the order-invariance
 *   // of the final stamp is computeBindingStamp's job (it sorts inputArtifactHashes).
 *   export function hashImageInputs(images: ImageInput[]): string[];
 *
 * The hash preimage is the raw image bytes ONLY — never the path — so a byte-
 * identical image at a different path yields an identical contribution, and an
 * image and a text input with identical bytes produce identical hashes (same
 * footing in inputArtifactHashes).
 *
 * Tests exercise the REAL loadImageInput + computeBindingStamp; hashImageInputs
 * is read structurally so this file type-checks against the current module while
 * B.A. adds the export. Nothing here reimplements or mocks the subject — AC1's
 * digest is pinned with a PRECOMPUTED SHA-256 golden vector (a constant), not a
 * re-derivation of the hashing logic.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadImageInput, type ImageInput } from './image-input';
import * as imageInputModule from './image-input';
import { computeBindingStamp } from '../checkpoint/checkpoint';

// ---------------------------------------------------------------------------
// Target helper (WI-417). Read structurally so this file compiles against the
// current image-input module (where the export does not yet exist). When absent
// at runtime, calling it throws "is not a function" — a crisp RED for B.A.
// ---------------------------------------------------------------------------
type HashImageInputs = (images: ImageInput[]) => string[];
const hashImageInputs = (imageInputModule as { hashImageInputs?: HashImageInputs })
  .hashImageInputs as HashImageInputs;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG signature + ASCII "ABCD". Stable bytes → stable golden SHA-256 below. */
const BASE_BYTES = Uint8Array.from([...PNG_SIGNATURE, 0x41, 0x42, 0x43, 0x44]);
/** PNG signature + ASCII "WXYZ" — a genuinely different image. */
const ALT_BYTES = Uint8Array.from([...PNG_SIGNATURE, 0x57, 0x58, 0x59, 0x5a]);
/** BASE_BYTES with exactly ONE byte changed ("ABCD" → "ABCE"). */
const ONE_BYTE_DIFF_BYTES = Uint8Array.from([...PNG_SIGNATURE, 0x41, 0x42, 0x43, 0x45]);

/** Precomputed SHA-256 hex of the exact BASE_BYTES / ALT_BYTES (golden vectors). */
const BASE_SHA256 = 'd4c41fbddfae6998dfb7774a59e0ee20c159f162be91e355aaaa972fcf3549af';
const ALT_SHA256 = 'fb576803738af0a1c6d6d9f05dbe6b40c97a19baec21b2ed7e94cdce546a0074';

/** Fixed non-image inputs to the stamp, so image-driven changes are isolated. */
const STAMP_BASE = { modelId: 'gpt-4o', promptTemplateVersion: 'v1', flowVersion: 1 };
/** Stand-in text-input content hashes (64-hex), as the executor would supply. */
const TEXT_HASH_A = 'a'.repeat(64);
const TEXT_HASH_B = 'b'.repeat(64);

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'conduit-img-stamp-'));
  createdDirs.push(root);
  return root;
}

/** Write image bytes to `relPath` under `root`; returns relPath for loadImageInput. */
function writeFixture(root: string, relPath: string, bytes: Uint8Array): string {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, Buffer.from(bytes));
  return relPath;
}

/** Load an ImageInput fixture in one step. */
function loadFixture(root: string, relPath: string, bytes: Uint8Array): ImageInput {
  return loadImageInput(root, writeFixture(root, relPath, bytes));
}

// ===========================================================================
// AC1 — the helper produces a SHA-256 hex contribution from the image bytes,
//        on the same digest footing as the executor's text-input hashing.
// ===========================================================================

describe('hashImageInputs — SHA-256 hex contribution from image bytes (AC1)', () => {
  it('produces a 64-char lowercase hex digest per image (SHA-256 encoding)', () => {
    const root = makeProjectRoot();
    const [hash] = hashImageInputs([loadFixture(root, 'a.png', BASE_BYTES)]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the raw image bytes with the same SHA-256 discipline as text inputs (golden vector)', () => {
    // The executor hashes a text input as sha256(fileBytes).hex. The image helper
    // must use the identical preimage (raw bytes) and encoding so image and text
    // contributions are interchangeable in inputArtifactHashes. Pinned against a
    // precomputed SHA-256 of the exact fixture bytes (a constant, not a reimpl).
    const root = makeProjectRoot();
    expect(hashImageInputs([loadFixture(root, 'a.png', BASE_BYTES)])).toEqual([BASE_SHA256]);
  });

  it('returns one contribution per image, in input order', () => {
    const root = makeProjectRoot();
    const imgA = loadFixture(root, 'a.png', BASE_BYTES);
    const imgB = loadFixture(root, 'b.png', ALT_BYTES);
    expect(hashImageInputs([imgA, imgB])).toEqual([BASE_SHA256, ALT_SHA256]);
  });
});

// ===========================================================================
// AC2 — changing one byte of the image changes the contribution AND the stamp
//        (changed image → different stamp → re-run on resume).
// ===========================================================================

describe('hashImageInputs — a changed image changes the contribution and the stamp (AC2)', () => {
  it('changing one byte of the image changes its hash contribution', () => {
    const root = makeProjectRoot();
    const [h1] = hashImageInputs([loadFixture(root, 'v1.png', BASE_BYTES)]);
    const [h2] = hashImageInputs([loadFixture(root, 'v2.png', ONE_BYTE_DIFF_BYTES)]);
    expect(h2).not.toBe(h1);
  });

  it('a changed image yields a different binding stamp (re-run on resume)', () => {
    const root = makeProjectRoot();
    const stamp1 = computeBindingStamp({
      ...STAMP_BASE,
      inputArtifactHashes: [TEXT_HASH_A, ...hashImageInputs([loadFixture(root, 'v1.png', BASE_BYTES)])],
    });
    const stamp2 = computeBindingStamp({
      ...STAMP_BASE,
      inputArtifactHashes: [TEXT_HASH_A, ...hashImageInputs([loadFixture(root, 'v2.png', ONE_BYTE_DIFF_BYTES)])],
    });
    expect(stamp2).not.toBe(stamp1);
  });
});

// ===========================================================================
// AC3 — a byte-identical image produces an identical contribution AND stamp
//        (unchanged image → same stamp → skip-on-resume permitted). The hash is
//        over BYTES only, not the path.
// ===========================================================================

describe('hashImageInputs — an unchanged image yields an identical contribution and stamp (AC3)', () => {
  it('byte-identical images produce the identical contribution, independent of path', () => {
    const root = makeProjectRoot();
    // Same bytes at two different paths — proves the hash preimage is the bytes,
    // not the path (guards against path leaking into the digest).
    const [h1] = hashImageInputs([loadFixture(root, 'first.png', BASE_BYTES)]);
    const [h2] = hashImageInputs([loadFixture(root, 'nested/second.png', BASE_BYTES)]);
    expect(h2).toBe(h1);
  });

  it('an unchanged image yields the same binding stamp (skip-on-resume permitted)', () => {
    const root = makeProjectRoot();
    const rel = writeFixture(root, 'a.png', BASE_BYTES);
    const stampFirst = computeBindingStamp({
      ...STAMP_BASE,
      inputArtifactHashes: [TEXT_HASH_A, ...hashImageInputs([loadImageInput(root, rel)])],
    });
    const stampSecond = computeBindingStamp({
      ...STAMP_BASE,
      inputArtifactHashes: [TEXT_HASH_A, ...hashImageInputs([loadImageInput(root, rel)])],
    });
    expect(stampSecond).toBe(stampFirst);
  });
});

// ===========================================================================
// AC4 — image-hash ordering is irrelevant to the final stamp (computeBindingStamp
//        sorts inputArtifactHashes) — verified for multiple image inputs.
// ===========================================================================

describe('hashImageInputs — image-hash ordering is irrelevant to the stamp (AC4)', () => {
  it('reordering multiple image inputs yields the same binding stamp', () => {
    const root = makeProjectRoot();
    const [ha, hb] = hashImageInputs([
      loadFixture(root, 'a.png', BASE_BYTES),
      loadFixture(root, 'b.png', ALT_BYTES),
    ]);
    // The two images are genuinely different, so the reorder is a meaningful test.
    expect(ha).not.toBe(hb);

    const stampAB = computeBindingStamp({ ...STAMP_BASE, inputArtifactHashes: [TEXT_HASH_A, ha, hb] });
    const stampBA = computeBindingStamp({ ...STAMP_BASE, inputArtifactHashes: [TEXT_HASH_A, hb, ha] });
    expect(stampBA).toBe(stampAB);
  });
});

// ===========================================================================
// AC5 / NFR-1 — a station with no image inputs produces the SAME stamp it does
//        today: the image contribution is empty and folds in nothing.
// ===========================================================================

describe('hashImageInputs — no image inputs leaves the stamp unchanged (AC5 / NFR-1)', () => {
  it('returns an empty contribution list for no image inputs', () => {
    expect(hashImageInputs([])).toEqual([]);
  });

  it('a text-only station produces the identical stamp it does today (no image contribution folded in)', () => {
    const textOnly = [TEXT_HASH_A, TEXT_HASH_B];
    const stampToday = computeBindingStamp({ ...STAMP_BASE, inputArtifactHashes: textOnly });
    const stampWithNoImages = computeBindingStamp({
      ...STAMP_BASE,
      inputArtifactHashes: [...textOnly, ...hashImageInputs([])],
    });
    expect(stampWithNoImages).toBe(stampToday);
  });
});
