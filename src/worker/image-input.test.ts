/**
 * Tests for the image-input seam + loader (WI-413, FR-2).
 *
 * This item adds a typed IMAGE channel to the kernel model-call seam
 * (src/worker/adapter.ts `ModelCall`) and a small utility that loads a declared
 * image path into the byte/metadata shape that channel carries. It is the SHARED
 * contract every other multimodal item builds on: WI-415 (adapter consumes it),
 * WI-419 (executor populates it), WI-417 (binding stamp hashes it), WI-420
 * (payload guard bounds it). This file pins that contract.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/worker/image-input.ts
 * ---------------------------------------------------------------------------
 *
 *   // The image-input shape carried on ModelCall.images. MINIMUM fields below;
 *   // the object is EXTENSIBLE (a future detail/resolution hint is additive,
 *   // Resolved Q4), so tests never assert it has ONLY these keys.
 *   export interface ImageInput {
 *     path: string;        // the resolved path of the loaded image file
 *     bytes: Uint8Array;   // the raw file bytes (Buffer is a Uint8Array subclass)
 *     mediaType: string;   // detected IMAGE media type, e.g. 'image/png'
 *     // ...additive fields allowed
 *   }
 *
 *   // Load a declared image path (relative to projectRoot) into an ImageInput.
 *   export function loadImageInput(
 *     projectRoot: string,
 *     declaredPath: string,
 *   ): ImageInput;
 *
 * And in src/worker/adapter.ts the `ModelCall` interface gains an OPTIONAL,
 * additive field — text-only calls are structurally unchanged (NFR-1):
 *
 *   export interface ModelCall {
 *     model: string;
 *     prompt: string;
 *     params: Record<string, unknown>;
 *     images?: ImageInput[];   // optional, bounded list (bounds are WI-420's job)
 *   }
 *
 * Behavioural contract pinned below:
 *  - loadImageInput reads a readable image under the project root and returns
 *    { path, bytes, mediaType } with bytes === the file's raw bytes and mediaType
 *    the detected IMAGE media type (AC3).
 *  - A missing/unreadable file throws a clear error NAMING the path, never a raw
 *    ENOENT — mirroring renderPrompt's missing-artifact style (AC4).
 *  - loadImageInput owns FORMAT detection: a non-image / undetectable file throws
 *    a clear error. SIZE/COUNT limits are WI-420's job and are NOT checked here
 *    (AC5).
 *  - The ImageInput object NEVER leaks raw bytes when stringified: JSON.stringify
 *    and String()/template coercion expose a path reference only, not the pixel
 *    bytes (NFR-3 / AC7).
 *  - The seam faithfully carries images the caller sets and omits the field when
 *    the caller does not — proving text-only calls are unaffected (NFR-1 / AC2).
 *
 * Tests inject a STUB ModelAdapter (no network) per adapter.ts's header. The real
 * functions under test are loadImageInput (and the ModelCall seam it feeds);
 * nothing in this file reimplements or mocks the subject.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join, isAbsolute } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadImageInput, type ImageInput } from './image-input';
import type { ModelCall, ModelAdapter, ModelResponse } from './adapter';

// ---------------------------------------------------------------------------
// Fixtures: throwaway project roots on real disk (matches render.test.ts style).
// Reading from a real projectRoot is the highest-fidelity way to exercise both
// the happy path ("read an image under the project root") and the failure paths
// ("file missing", "not an image"). All temp dirs are torn down after each test.
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** The 8-byte PNG signature (magic number) that starts every PNG file. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The JPEG/JFIF leading bytes (SOI + APP0 'JFIF'). */
const JPEG_JFIF = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00];

/**
 * Build PNG file bytes: the real PNG signature followed by an ASCII marker that
 * stands in for "pixel data". The signature makes the file detect as image/png
 * (whether detection is by magic number or by the .png extension); the marker is
 * a recognisable needle used to prove raw bytes never leak into serialisations.
 */
function pngBytesWithMarker(marker: string): Uint8Array {
  const markerBytes = new TextEncoder().encode(marker);
  const out = new Uint8Array(PNG_SIGNATURE.length + markerBytes.length);
  out.set(PNG_SIGNATURE, 0);
  out.set(markerBytes, PNG_SIGNATURE.length);
  return out;
}

/** Create a throwaway project root. Returns the absolute root path. */
function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'conduit-image-input-'));
  createdDirs.push(root);
  return root;
}

/**
 * Write `bytes` to `relPath` under `root`, creating parent dirs as needed.
 * Returns the relative path (the second argument to loadImageInput).
 */
function writeFixture(root: string, relPath: string, bytes: Uint8Array | string): string {
  const abs = join(root, relPath);
  const dir = abs.slice(0, abs.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes));
  return relPath;
}

/** A recording stub adapter: captures every ModelCall and returns a canned reply. */
const CANNED_RESPONSE: ModelResponse = { text: 'ok', inputTokens: 1, outputTokens: 1, costUsd: 0 };
function recordingAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return CANNED_RESPONSE;
    },
  };
  return { adapter, calls };
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
// AC3 — loadImageInput returns the image-input object (bytes + detected media
//        type derived from the file) for a readable image under the project root.
// ===========================================================================

describe('loadImageInput — loads a readable image under the project root (AC3)', () => {
  it.each([
    ['png', 'assets/logo.png', () => pngBytesWithMarker('PIXELDATA_x01'), 'image/png'],
    ['jpeg', 'assets/photo.jpg', () => Uint8Array.from(JPEG_JFIF), 'image/jpeg'],
  ])('loads a %s file: bytes match the file, mediaType is detected', (_label, rel, makeBytes, expectedMediaType) => {
    const root = makeProjectRoot();
    const fileBytes = (makeBytes as () => Uint8Array)();
    writeFixture(root, rel as string, fileBytes);

    const img: ImageInput = loadImageInput(root, rel as string);

    // mediaType is the IMAGE media type detected from the file.
    expect(img.mediaType).toBe(expectedMediaType as string);
    // bytes are the file's raw bytes, verbatim (Buffer.from tolerates Uint8Array/Buffer).
    expect(Buffer.from(img.bytes).equals(Buffer.from(fileBytes))).toBe(true);
  });

  it('exposes a resolved, absolute path that points back at the loaded file', () => {
    const root = makeProjectRoot();
    const fileBytes = pngBytesWithMarker('PIXELDATA_x02');
    const rel = writeFixture(root, 'assets/logo.png', fileBytes);

    const img = loadImageInput(root, rel);

    // The resolved path is absolute...
    expect(isAbsolute(img.path)).toBe(true);
    // ...and reading it back yields the exact same bytes (proves it points at the
    // real file, independent of join-vs-realpath normalisation differences).
    expect(Buffer.from(readFileSync(img.path)).equals(Buffer.from(fileBytes))).toBe(true);
  });
});

// ===========================================================================
// AC4 — a missing / unreadable file throws a clear error NAMING the path, never
//        a raw ENOENT (mirrors renderPrompt's missing-artifact message style).
// ===========================================================================

describe('loadImageInput — missing/unreadable file throws a clear, path-naming error (AC4)', () => {
  it('throws an error that names the missing path', () => {
    const root = makeProjectRoot(); // nothing written

    expect(() => loadImageInput(root, 'assets/missing.png')).toThrow(/missing\.png/);
  });

  it('surfaces a human-actionable message, not a raw ENOENT', () => {
    const root = makeProjectRoot();
    const load = () => loadImageInput(root, 'assets/missing.png');

    expect(load).toThrow(/missing\.png/);
    const message = thrownMessage(load);
    expect(message).not.toMatch(/ENOENT/);
  });
});

// ===========================================================================
// AC5 — loadImageInput OWNS format detection: a file whose IMAGE media type
//        cannot be detected throws a clear error. SIZE/COUNT limits are WI-420's
//        responsibility and are intentionally NOT exercised here.
// ===========================================================================

describe('loadImageInput — undetectable / non-image format throws a clear error (AC5)', () => {
  it.each([
    ['plain text with a .txt extension', 'notes.txt', 'this is definitely not an image'],
    ['random bytes with no image extension', 'mystery', Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x7f, 0x10])],
  ])('rejects %s', (_label, rel, contents) => {
    const root = makeProjectRoot();
    writeFixture(root, rel as string, contents as Uint8Array | string);

    const load = () => loadImageInput(root, rel as string);

    // It throws because the file is not a recognisable image format...
    expect(load).toThrow();
    // ...with a clear, non-ENOENT message (the file IS readable; the problem is format).
    const message = thrownMessage(load);
    expect(message).not.toMatch(/ENOENT/);
    // The message must NAME the offending file and indicate the problem is the
    // image format/type (not a bare non-empty string — Lynch P2 / Amy INFO).
    expect(message).toContain(rel as string);
    expect(message).toMatch(/format|image/i);
  });
});

// ===========================================================================
// Path traversal (NFR-2 input-scope discipline) — a declaredPath that resolves
// OUTSIDE projectRoot must be rejected, not silently read. join() normalises
// "../" but does not constrain to the root, so the read path needs an explicit
// bounds check (the Law guards writes for agentic stations; this transform
// read-path has no other protection). Reading e.g. ../../etc/passwd is a
// confidentiality hole, so the loader must throw rather than return the file.
// ===========================================================================

describe('loadImageInput — rejects declaredPaths that escape the project root', () => {
  it.each([
    ['a parent-relative path', '../secret.png'],
    ['a nested parent-relative path', 'sub/../../secret.png'],
  ])('throws for %s instead of reading the file outside the root', (_label, declaredPath) => {
    // Lay out outer/{project, secret.png}. secret.png is a VALID PNG, so a
    // SUCCESSFUL load would prove the traversal escape — the loader must block it.
    const outer = mkdtempSync(join(tmpdir(), 'conduit-traversal-'));
    createdDirs.push(outer);
    const root = join(outer, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outer, 'secret.png'), Buffer.from(pngBytesWithMarker('OUTSIDE_ROOT_SECRET')));

    const load = () => loadImageInput(root, declaredPath);

    // It must throw — the escaping path is rejected, the outside file is not returned.
    expect(load).toThrow();
    const message = thrownMessage(load);
    // The file EXISTS and is readable, so a raw ENOENT would be the wrong failure;
    // this is a scope/bounds rejection that names the offending file.
    expect(message).not.toMatch(/ENOENT/);
    expect(message).toContain('secret.png');
  });

  // Code-review fix #4 — the lexical prefix check cannot see through a symlink
  // that lives INSIDE projectRoot but points OUTSIDE it. The real-path guard
  // must resolve the link and reject the out-of-root target BEFORE reading.
  it('rejects a symlink inside the root that points outside it (symlink escape)', () => {
    const outer = mkdtempSync(join(tmpdir(), 'conduit-symlink-'));
    createdDirs.push(outer);
    const root = join(outer, 'project');
    mkdirSync(root, { recursive: true });
    // A real, readable PNG sitting OUTSIDE the project root.
    writeFileSync(join(outer, 'secret.png'), Buffer.from(pngBytesWithMarker('OUTSIDE_VIA_SYMLINK')));
    // A symlink at project/leak.png → ../secret.png. Its declared path is
    // lexically under root, so the old startsWith() check would have passed it.
    symlinkSync(join(outer, 'secret.png'), join(root, 'leak.png'));

    const load = () => loadImageInput(root, 'leak.png');

    expect(load).toThrow();
    const message = thrownMessage(load);
    expect(message).not.toMatch(/ENOENT/);
    // Bounds rejection (names the out-of-root real path), not a read error.
    expect(message).toMatch(/outside the project root/);
  });

  it('still loads a normal symlink that stays inside the root', () => {
    const root = makeProjectRoot();
    const realRel = writeFixture(root, 'assets/real.png', pngBytesWithMarker('INSIDE_LINK_TARGET'));
    symlinkSync(join(root, realRel), join(root, 'alias.png'));
    const img = loadImageInput(root, 'alias.png');
    // The link target is in-root, so the bytes load cleanly.
    expect(img.bytes.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// AC7 / NFR-3 — the ImageInput object never leaks raw bytes. JSON.stringify and
//        String()/template coercion expose a path reference only, not the pixel
//        bytes (no image bytes in logs/errors).
// ===========================================================================

describe('ImageInput — stringifies to a path reference, never raw bytes (AC7 / NFR-3)', () => {
  const MARKER = 'PIXELDATA_SECRET_DEADBEEF_7F3A';

  /** True if `serialized` contains the marker bytes in any plausible serialisation form. */
  function leaksMarker(serialized: string): boolean {
    const markerBytes = new TextEncoder().encode(MARKER);
    const asAscii = MARKER; // utf-8/latin1 dump of the bytes
    const asNumbers = Array.from(markerBytes).join(','); // contiguous number-array dump
    const asBase64 = Buffer.from(markerBytes).toString('base64'); // base64 dump
    // Bun.inspect / console.log render a Uint8Array as "137, 80, 78, ..." with a
    // comma-SPACE separator. Normalise whitespace away so the number-array form is
    // detected regardless of spacing (JSON.stringify emits it contiguous).
    const stripped = serialized.replace(/\s+/g, '');
    return (
      serialized.includes(asAscii) ||
      stripped.includes(asNumbers) ||
      serialized.includes(asBase64)
    );
  }

  it('JSON.stringify(img) references the path and does not dump the raw bytes', () => {
    const root = makeProjectRoot();
    const rel = writeFixture(root, 'assets/logo.png', pngBytesWithMarker(MARKER));
    const img = loadImageInput(root, rel);

    const serialized = JSON.stringify(img);

    expect(leaksMarker(serialized)).toBe(false);
    // The serialised form still carries a useful reference to the source file.
    expect(serialized).toContain('logo.png');
  });

  it('String(img) and template coercion reference the path and never the raw bytes', () => {
    const root = makeProjectRoot();
    const rel = writeFixture(root, 'assets/logo.png', pngBytesWithMarker(MARKER));
    const img = loadImageInput(root, rel);

    const asString = String(img);
    const asTemplate = `${img}`;

    expect(leaksMarker(asString)).toBe(false);
    expect(leaksMarker(asTemplate)).toBe(false);
    expect(asString).toContain('logo.png');
    expect(asTemplate).toContain('logo.png');
  });

  it('Bun.inspect(img) (the console.log path) references the path, never the raw bytes', () => {
    // console.log / Bun.inspect use Symbol(nodejs.util.inspect.custom) and walk
    // Object.getOwnPropertyNames — which BYPASSES enumerable:false, toJSON, and
    // toString. NFR-3 ("no image bytes in logs") therefore requires a custom
    // inspect hook; a non-enumerable `bytes` alone is not enough.
    const root = makeProjectRoot();
    const rel = writeFixture(root, 'assets/logo.png', pngBytesWithMarker(MARKER));
    const img = loadImageInput(root, rel);

    const inspected = Bun.inspect(img);

    expect(leaksMarker(inspected)).toBe(false);
    // Still a useful, log-safe reference to the source file.
    expect(inspected).toContain('logo.png');
  });

  it('does not leak bytes even when embedded in a ModelCall that is logged', () => {
    // AC1 × AC7: the whole ModelCall must be log-safe, because the seam carries
    // the ImageInput. Both structured serialisation (JSON.stringify) and the
    // console.log/Bun.inspect path a worker would actually use must not spill
    // pixel bytes.
    const root = makeProjectRoot();
    const rel = writeFixture(root, 'assets/logo.png', pngBytesWithMarker(MARKER));
    const img = loadImageInput(root, rel);

    const call: ModelCall = { model: 'gpt-4o-mini', prompt: 'describe', params: {}, images: [img] };

    expect(leaksMarker(JSON.stringify(call))).toBe(false);
    expect(leaksMarker(Bun.inspect(call))).toBe(false);
  });
});

// ===========================================================================
// AC1 — the ModelCall seam carries a bounded LIST of structured image-input
//        objects (path + bytes + mediaType), NOT bare strings. A real
//        loadImageInput result travels through a stub adapter intact.
// ===========================================================================

describe('ModelCall seam — carries structured image inputs to the adapter (AC1)', () => {
  it('delivers a loaded image (path, bytes, mediaType) to the adapter unchanged', async () => {
    const root = makeProjectRoot();
    const fileBytes = pngBytesWithMarker('PIXELDATA_x03');
    const rel = writeFixture(root, 'assets/logo.png', fileBytes);
    const img = loadImageInput(root, rel);

    const { adapter, calls } = recordingAdapter();
    const call: ModelCall = { model: 'gpt-4o-mini', prompt: 'describe', params: {}, images: [img] };
    await adapter.call(call);

    expect(calls).toHaveLength(1);
    const received = calls[0].images;
    expect(received).toHaveLength(1);
    // The image-input is a structured object, not a bare string.
    expect(typeof received![0]).toBe('object');
    expect(received![0].mediaType).toBe('image/png');
    expect(Buffer.from(received![0].bytes).equals(Buffer.from(fileBytes))).toBe(true);
  });

  it('carries a bounded list of multiple images, each with its own detected media type', async () => {
    const root = makeProjectRoot();
    const pngRel = writeFixture(root, 'assets/logo.png', pngBytesWithMarker('PIXELDATA_x04'));
    const jpgRel = writeFixture(root, 'assets/photo.jpg', Uint8Array.from(JPEG_JFIF));
    const pngImg = loadImageInput(root, pngRel);
    const jpgImg = loadImageInput(root, jpgRel);

    const { adapter, calls } = recordingAdapter();
    const call: ModelCall = {
      model: 'gpt-4o-mini',
      prompt: 'compare',
      params: {},
      images: [pngImg, jpgImg],
    };
    await adapter.call(call);

    const received = calls[0].images;
    expect(received).toHaveLength(2);
    expect(received![0].mediaType).toBe('image/png');
    expect(received![1].mediaType).toBe('image/jpeg');
  });
});

// ===========================================================================
// AC2 / NFR-1 — a ModelCall with no images is structurally identical to today's
//        text-only call: the field is driven SOLELY by the caller. The seam
//        omits images when the caller omits them (text-only transforms
//        unaffected) and carries them when the caller sets them.
// ===========================================================================

describe('ModelCall seam — text-only calls are unaffected; images are caller-driven (AC2 / NFR-1)', () => {
  it('a text-only ModelCall reaches the adapter with NO images key', async () => {
    const { adapter, calls } = recordingAdapter();
    // Constructed exactly as a text-only transform does today — no images field.
    const call: ModelCall = { model: 'gpt-4o-mini', prompt: 'just text', params: {} };
    await adapter.call(call);

    const received = calls[0];
    // Structurally identical to today's shape: the optional field is absent,
    // not auto-populated to an empty list by the seam.
    expect('images' in received).toBe(false);
    expect(received.images).toBeUndefined();
  });

  it('contrast: the SAME seam carries images when (and only when) the caller sets them', async () => {
    const root = makeProjectRoot();
    const rel = writeFixture(root, 'assets/logo.png', pngBytesWithMarker('PIXELDATA_x05'));
    const img = loadImageInput(root, rel);

    const { adapter, calls } = recordingAdapter();
    await adapter.call({ model: 'm', prompt: 'text only', params: {} });
    await adapter.call({ model: 'm', prompt: 'with image', params: {}, images: [img] });

    // Field presence tracks the caller's intent exactly — no leakage between calls.
    expect('images' in calls[0]).toBe(false);
    expect(calls[1].images).toHaveLength(1);
  });
});
