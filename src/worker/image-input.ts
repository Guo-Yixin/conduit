/**
 * Image-input seam for the ModelCall channel (WI-413, FR-2).
 *
 * Defines the typed ImageInput shape carried on ModelCall.images and the
 * loadImageInput utility that resolves a declared image path to that shape.
 *
 * This is the SHARED contract that WI-415 (adapter consumption), WI-417
 * (binding stamp hashing), WI-419 (executor population), and WI-420 (payload
 * guard) build on — keep it extensible (Resolved Q4: additive fields are fine).
 *
 * NFR-3 SAFETY: ImageInput objects NEVER leak raw bytes into serialisations.
 * JSON.stringify, String(), template coercion, AND Bun.inspect/console.log all
 * surface a path reference only. Enforced by:
 *   - Non-enumerable `bytes` property (excluded from JSON object key enumeration)
 *   - toJSON() returning { path, mediaType } with no bytes
 *   - toString() returning a human-readable path reference
 *   - [Bun.inspect.custom]() returning the same path reference — Bun.inspect()
 *     and console.log walk getOwnPropertyNames and use the custom inspect symbol,
 *     bypassing enumerable:false + toJSON + toString without this hook.
 *
 * NFR-2 SAFETY: loadImageInput enforces that the resolved path stays within
 * projectRoot. join() normalises "../" but does not constrain to the root — an
 * explicit bounds check prevents confidentiality holes from path traversal.
 *
 * Error style mirrors renderPrompt in src/flow/render.ts: missing or unreadable
 * files throw a human-actionable message naming the path, never a raw ENOENT.
 */

import { join, extname } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MAX_IMAGE_INPUTS_PER_CALL } from '../flow/load';

// ---------------------------------------------------------------------------
// Public interface — EXTENSIBLE (future detail/resolution hint is additive).
// Tests never assert "only these keys", so fields may be added without breaking.
// ---------------------------------------------------------------------------

/**
 * The image-input shape carried on ModelCall.images. Carries the resolved path,
 * raw bytes, and detected media type of a declared image artifact.
 *
 * Intentionally extensible: a `detail` or `resolution` hint from a future item
 * is additive and will not break existing consumers.
 */
export interface ImageInput {
  /** Absolute resolved path of the loaded image file. */
  path: string;
  /**
   * Raw file bytes. Non-enumerable on concrete instances — excluded from
   * JSON.stringify so pixel bytes never appear in logs or error messages (NFR-3).
   * Accessible as a normal property read.
   */
  bytes: Uint8Array;
  /** Detected IMAGE media type, e.g. 'image/png' or 'image/jpeg'. */
  mediaType: string;
}

// ---------------------------------------------------------------------------
// Internal — media-type detection
// ---------------------------------------------------------------------------

/**
 * Known image file extensions mapped to their IANA media type.
 * Used as a fallback when magic-number detection is inconclusive.
 */
const IMAGE_EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

/**
 * Detect the IMAGE media type of a file from its magic bytes, falling back to
 * extension. Returns `null` when the format is not a recognisable image type.
 *
 * Detection order: magic-number (authoritative) → extension (fallback).
 * Both techniques must agree on the supported set tested by the fixture suite.
 */
function detectImageMediaType(bytes: Uint8Array, filePath: string): string | null {
  // PNG: 8-byte signature 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: SOI marker FF D8 followed by an FF-prefixed APP marker
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: GIF87a or GIF89a
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  // BMP: BM
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }

  // Extension-based fallback — for formats without a universally recognised
  // magic number or when the file has a clear, trusted extension.
  const ext = extname(filePath).toLowerCase();
  return IMAGE_EXTENSION_MEDIA_TYPES[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Internal — byte-safe ImageInput factory (NFR-3)
// ---------------------------------------------------------------------------

/**
 * Serialisation-safe view of an ImageInput, returned by toJSON().
 * Omits bytes so pixel data never appears in JSON logs.
 */
interface ImageInputJson {
  path: string;
  mediaType: string;
}

/**
 * Concrete ImageInput implementation with non-enumerable bytes (NFR-3).
 *
 * `bytes` is defined via Object.defineProperty in the constructor so it is
 * accessible as a normal property read but excluded from JSON.stringify key
 * enumeration. `declare` tells TypeScript the property exists at runtime
 * without triggering strictPropertyInitialization for a missing initializer.
 *
 * Serialisation guarantees:
 *   - JSON.stringify(instance) → { path, mediaType } — no bytes.
 *   - String(instance) / `${instance}` → "ImageInput(<path>)" — no bytes.
 *   - Bun.inspect(instance) / console.log(instance) → "ImageInput(<path>)" — no bytes.
 *   - instance.bytes is fully accessible for callers that need the raw data.
 */
class ImageInputImpl implements ImageInput {
  // `declare` signals to TypeScript that the property exists at runtime (set
  // via defineProperty below) without an initializer assignment. This is the
  // standard pattern for externally-managed properties in strict mode.
  declare readonly bytes: Uint8Array;

  constructor(
    readonly path: string,
    bytes: Uint8Array,
    readonly mediaType: string,
  ) {
    // Non-enumerable: JSON.stringify will not visit this key, so raw pixel bytes
    // never appear in logs or error messages (NFR-3 enforcement point).
    Object.defineProperty(this, 'bytes', {
      value: bytes,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  toJSON(): ImageInputJson {
    return { path: this.path, mediaType: this.mediaType };
  }

  toString(): string {
    return `ImageInput(${this.path})`;
  }

  /**
   * Bun.inspect / console.log custom hook (NFR-3).
   *
   * Bun.inspect() walks Object.getOwnPropertyNames and uses this symbol before
   * falling back to its default renderer. Without it, even a non-enumerable
   * `bytes` property appears in console.log output — leaking raw pixel bytes
   * into development logs. This method returns the same path-only reference
   * as toString() so the log output is both safe and informative.
   */
  [Bun.inspect.custom](): string {
    return `ImageInput(${this.path})`;
  }
}

/** Factory — returns an ImageInput whose bytes are hidden from serialisation. */
function makeImageInput(resolvedPath: string, fileBytes: Uint8Array, detectedMediaType: string): ImageInput {
  return new ImageInputImpl(resolvedPath, fileBytes, detectedMediaType);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a declared image path into an ImageInput.
 *
 * Reads `join(projectRoot, declaredPath)`, detects the IMAGE media type from
 * the file bytes (magic-number first, extension fallback), and returns an
 * ImageInput whose bytes are the raw file contents.
 *
 * Error contract (mirrors renderPrompt's missing-artifact style):
 *   - Missing / unreadable file → throws naming the path, never a raw ENOENT.
 *   - Undetectable / non-image format → throws a clear format-rejection error.
 *   - SIZE / COUNT limits are NOT applied here — that is WI-420's responsibility.
 *
 * @param projectRoot  Absolute directory under which declared images live.
 * @param declaredPath Path relative to projectRoot as declared in the flow config.
 * @returns            An ImageInput with resolved absolute path, raw bytes, and
 *                     detected media type. The object is log-safe (NFR-3).
 * @throws If declaredPath resolves outside projectRoot (path traversal guard).
 * @throws If the file is missing or unreadable (path named in message, no ENOENT).
 * @throws If the file format is not a recognised image type.
 */
export function loadImageInput(projectRoot: string, declaredPath: string): ImageInput {
  const resolvedPath = join(projectRoot, declaredPath);

  // ── NFR-2: path traversal guard (check BEFORE any disk read) ─────────────
  // join() normalises "../" sequences but does NOT constrain the result to
  // projectRoot. A declaredPath of "../secret.png" silently reads outside the
  // project root, creating a confidentiality hole. We verify the resolved path
  // is strictly under projectRoot before touching the filesystem.
  //
  // We append a trailing sep to projectRoot before the prefix check so that a
  // projectRoot of "/tmp/proj" does not accidentally match "/tmp/proj-other/…".
  const lexicalRootPrefix = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  if (resolvedPath !== projectRoot && !resolvedPath.startsWith(lexicalRootPrefix)) {
    throw new Error(
      `Image "${declaredPath}" resolves to "${resolvedPath}" which is outside the project root "${projectRoot}"`,
    );
  }

  // ── Symlink-escape guard: the lexical check above cannot see through a
  // symlink that lives INSIDE projectRoot but points OUTSIDE it. Resolve real
  // paths (matching the executor's output path-ownership guard) and re-check
  // containment BEFORE reading bytes, so a malicious link cannot launder an
  // out-of-root read. realpathSync requires the path to exist; a missing file
  // falls through to the same "could not be read" error as a plain ENOENT.
  let realResolvedPath: string;
  try {
    realResolvedPath = realpathSync(resolvedPath);
  } catch {
    throw new Error(
      `Image "${declaredPath}" could not be read from "${resolvedPath}"`,
    );
  }
  // projectRoot may itself be reached via a symlink; resolve it too so the
  // comparison is real-path vs real-path. If projectRoot cannot be resolved
  // (should not happen for a running flow), fall back to the lexical form.
  let realRoot: string;
  try {
    realRoot = realpathSync(projectRoot);
  } catch {
    realRoot = projectRoot;
  }
  const realRootPrefix = realRoot.endsWith('/') ? realRoot : realRoot + '/';
  if (realResolvedPath !== realRoot && !realResolvedPath.startsWith(realRootPrefix)) {
    throw new Error(
      `Image "${declaredPath}" resolves to "${realResolvedPath}" which is outside the project root "${realRoot}"`,
    );
  }

  let fileBytes: Uint8Array;
  try {
    fileBytes = new Uint8Array(readFileSync(realResolvedPath));
  } catch {
    throw new Error(
      `Image "${declaredPath}" could not be read from "${resolvedPath}"`,
    );
  }

  const detectedMediaType = detectImageMediaType(fileBytes, declaredPath);
  if (detectedMediaType === null) {
    throw new Error(
      `Image "${declaredPath}" is not a recognised image format — only PNG, JPEG, GIF, WebP, BMP, AVIF, HEIC/HEIF, and TIFF are supported`,
    );
  }

  return makeImageInput(resolvedPath, fileBytes, detectedMediaType);
}

// ---------------------------------------------------------------------------
// Binding-stamp contribution (WI-417)
// ---------------------------------------------------------------------------

/**
 * Produce one SHA-256 hex digest per image input, in the same order as the
 * input array, for folding into `inputArtifactHashes` on the checkpoint binding
 * stamp.
 *
 * Hash discipline matches the executor's text-input hashing exactly (see
 * src/controller/executor.ts ~729–748):
 *   `createHash('sha256').update(bytes).digest('hex')`
 *
 * The hash preimage is the raw image bytes ONLY — never the path — so:
 *   - A byte-identical image at a different path yields the same contribution
 *     (skip-on-resume is path-independent, AC3).
 *   - An image and a text input with identical bytes produce identical hashes
 *     (same footing in inputArtifactHashes).
 *
 * Order is preserved (one hex per input image). Order-invariance of the final
 * stamp is computeBindingStamp's responsibility — it sorts inputArtifactHashes
 * before hashing, so callers may concatenate image hashes in any order.
 *
 * @param images - The resolved image inputs to hash. An empty array returns `[]`
 *                 so that text-only stamps are unaffected (NFR-1, AC5).
 * @returns One 64-character lowercase hex SHA-256 digest per image, in order.
 */
export function hashImageInputs(images: ImageInput[]): string[] {
  return images.map((image) =>
    createHash('sha256').update(image.bytes).digest('hex'),
  );
}

// ---------------------------------------------------------------------------
// Per-call payload guard (WI-420, FR-9)
// ---------------------------------------------------------------------------

/**
 * Maximum allowed byte size per image, near the provider's documented limit.
 *
 * 20 MB (20 × 1 024 × 1 024 = 20 971 520 bytes) — matches the OpenAI/LiteLLM
 * documented per-image ceiling at the time of writing. Tests require a positive
 * integer in the range [1 000 000, 64 000 000]; this value satisfies that range.
 */
export const MAX_IMAGE_BYTES = 20_971_520;

/**
 * Assert that an image list is within the configured per-call byte-size and
 * count limits, throwing a clear kernel Error before the call reaches the
 * gateway if either limit is exceeded.
 *
 * Scope: SIZE and COUNT limits only. Format detection ("can't detect media
 * type → throw") is `loadImageInput`'s responsibility (WI-413) and fires
 * upstream of this guard — the two compose naturally.
 *
 * @param images  Resolved image inputs to check. An empty list always passes.
 * @param limits  Optional overrides for either limit.
 *   - `maxBytes`  Per-image ceiling in bytes (default: `MAX_IMAGE_BYTES`).
 *   - `maxCount`  Maximum number of images per call (default:
 *                 `MAX_IMAGE_INPUTS_PER_CALL` from WI-414, so the dispatch-time
 *                 check agrees with the load-time bounded-list check).
 * @throws If `images.length > maxCount` — error states the count and the limit.
 * @throws If any `image.bytes.length > maxBytes` — error names the offending
 *         image's path and the limit; does NOT name within-limit images.
 */
export function assertImagePayloadWithinLimits(
  images: ImageInput[],
  limits?: { maxBytes?: number; maxCount?: number },
): void {
  const maxBytes = limits?.maxBytes ?? MAX_IMAGE_BYTES;
  const maxCount = limits?.maxCount ?? MAX_IMAGE_INPUTS_PER_CALL;

  // Count guard — checked first so a too-many-images error is not obscured by
  // an incidental oversized-image error from the same malformed call.
  if (images.length > maxCount) {
    throw new Error(
      `Image call has ${images.length} images but the per-call maximum is ${maxCount}`,
    );
  }

  // Per-image byte guard — iterate in declared order and throw on the first
  // offending image, naming only that image (not the within-limit ones).
  for (const image of images) {
    if (image.bytes.length > maxBytes) {
      throw new Error(
        `Image "${image.path}" is ${image.bytes.length} bytes which exceeds the per-image limit of ${maxBytes} bytes`,
      );
    }
  }
}
