/**
 * Tests for multimodal (content-parts) request assembly in the OpenAI-compatible
 * adapter (WI-415, FR-3 / NFR-1 / NFR-3).
 *
 * When a ModelCall carries `images` (the field added by WI-413), the adapter
 * (src/worker/openai-adapter.ts executeModelCall, body assembly ~line 164) must
 * build a content-parts user message — a text part plus one image part per
 * declared image, in the OpenAI vision wire shape — instead of the current
 * single text-content string. A call with NO images keeps today's exact wire
 * shape, byte-for-byte. Usage parsing is explicitly out of scope here (WI-418).
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/worker/openai-adapter.ts
 * ---------------------------------------------------------------------------
 *
 *   Text-only call (no images / empty images) — UNCHANGED legacy shape (NFR-1):
 *     messages: [{ role: 'user', content: <prompt string> }]
 *
 *   Image call (images present, length > 0) — OpenAI content-parts shape:
 *     messages: [{ role: 'user', content: [
 *       { type: 'text',      text: <prompt> },
 *       { type: 'image_url', image_url: { url: 'data:<mediaType>;base64,<bytes>' } },
 *       ...one image part per declared image, in declared order
 *     ]}]
 *
 *   - Response reading is unchanged: only choices[0].message.content is read; an
 *     echoed/returned image in the response is ignored (AC3).
 *   - Image bytes appear ONLY in the request body, never in a thrown error or log
 *     line (NFR-3); API-key redaction is unchanged (AC4).
 *   - filterAllowedParams() and the 429/5xx bounded-retry behaviour are unchanged
 *     for both image and text-only calls (AC5).
 *
 * Every test injects the HTTP transport (a fetch stub) and a fake env — NOTHING
 * here touches a real network. Image inputs are produced by the REAL
 * loadImageInput (WI-413) reading throwaway fixture files, so the encoded data
 * URLs reflect real bytes + detected media types.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createOpenAiAdapter } from './openai-adapter';
import { loadImageInput, type ImageInput } from './image-input';

// ---------------------------------------------------------------------------
// Fetch stub — records every request so tests can assert on the body. (Mirrors
// the helper in openai-adapter.test.ts; no real network is ever touched.)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function makeFetchStub(
  handler: (req: CapturedRequest, callIndex: number) => Response | Promise<Response>,
): { fetchFn: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    const captured: CapturedRequest = { url, init: init ?? {} };
    calls.push(captured);
    return handler(captured, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Parse the JSON body of a captured request. */
function jsonBody(req: CapturedRequest): Record<string, unknown> {
  return JSON.parse(String(req.init.body)) as Record<string, unknown>;
}

/** An OpenAI-compatible chat/completions success Response. */
function chatResponse(text = 'a caption', status = 200): Response {
  const payload = {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE_URL = 'https://gateway.example/v1';
const API_KEY = 'sk-test-key';
function envWithKey(): Record<string, string | undefined> {
  return { CONDUIT_API_KEY: API_KEY, CONDUIT_BASE_URL: BASE_URL };
}

/** Capture the rejection message of a promise, or fail if it resolves. */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the call to reject, but it resolved');
}

// ---------------------------------------------------------------------------
// Image fixtures — real files under a throwaway project root (WI-413 loader).
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_JFIF = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00];

function pngBytesWithMarker(marker: string): Uint8Array {
  const markerBytes = new TextEncoder().encode(marker);
  const out = new Uint8Array(PNG_SIGNATURE.length + markerBytes.length);
  out.set(PNG_SIGNATURE, 0);
  out.set(markerBytes, PNG_SIGNATURE.length);
  return out;
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'conduit-mm-adapter-'));
  createdDirs.push(root);
  return root;
}

function writeFixture(root: string, relPath: string, bytes: Uint8Array): string {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, Buffer.from(bytes));
  return relPath;
}

/** Load a freshly-written PNG (optionally carrying a marker in its bytes). */
function loadPng(marker = 'PIXELDATA_x'): ImageInput {
  const root = makeProjectRoot();
  return loadImageInput(root, writeFixture(root, 'assets/logo.png', pngBytesWithMarker(marker)));
}

/** Load a freshly-written JPEG. */
function loadJpeg(): ImageInput {
  const root = makeProjectRoot();
  return loadImageInput(root, writeFixture(root, 'assets/photo.jpg', Uint8Array.from(JPEG_JFIF)));
}

/** The expected OpenAI data-URL for an image input (detected media type + base64 bytes). */
function dataUrl(img: ImageInput): string {
  return `data:${img.mediaType};base64,${Buffer.from(img.bytes).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Content-parts extraction helpers.
// ---------------------------------------------------------------------------

interface LoosePart {
  type: string;
  text?: string;
  image_url?: { url?: string };
}

/** The `content` of the single user message in a captured request body. */
function userContent(req: CapturedRequest): unknown {
  const body = jsonBody(req) as { messages?: Array<{ role: string; content: unknown }> };
  const user = (body.messages ?? []).find((m) => m.role === 'user');
  if (!user) throw new Error(`request body has no user message: ${String(req.init.body)}`);
  return user.content;
}

/** Assert the content is a content-parts array and return it (clear failure otherwise). */
function asParts(content: unknown): LoosePart[] {
  if (!Array.isArray(content)) {
    throw new Error(`expected a content-parts array, got ${typeof content}: ${JSON.stringify(content)}`);
  }
  return content as LoosePart[];
}

// ===========================================================================
// AC1 — an image call produces a content-parts user message: text part + one
//        image part per declared image, each a data URL with detected media type.
// ===========================================================================

describe('multimodal request — content-parts assembly for image calls (AC1)', () => {
  it('builds [text part + one image part] for a single image, as an OpenAI data URL', async () => {
    const img = loadPng('PIXELDATA_single');
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({ model: 'gpt-4o', prompt: 'describe this', params: {}, images: [img] });

    const parts = asParts(userContent(calls[0]!));
    const textParts = parts.filter((p) => p.type === 'text');
    expect(textParts).toHaveLength(1);
    expect(textParts[0]!.text).toBe('describe this');

    const imageUrls = parts.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url);
    expect(imageUrls).toEqual([dataUrl(img)]);
  });

  it('carries multiple images as one image part each, in declared order, with their media types', async () => {
    const png = loadPng('PIXELDATA_multi');
    const jpg = loadJpeg();
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({ model: 'gpt-4o', prompt: 'compare', params: {}, images: [png, jpg] });

    const parts = asParts(userContent(calls[0]!));
    expect(parts.filter((p) => p.type === 'text')).toHaveLength(1);

    const imageUrls = parts.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url);
    // Order preserved AND each carries its own detected media type (png then jpeg).
    expect(imageUrls).toEqual([dataUrl(png), dataUrl(jpg)]);
    expect(imageUrls[0]).toContain('data:image/png;base64,');
    expect(imageUrls[1]).toContain('data:image/jpeg;base64,');
  });

  it('round-trips the raw image bytes: the data URL decodes back to the file bytes', async () => {
    // Boundary transformation: binary PNG bytes (incl. the 0x89 signature) MUST
    // be base64-encoded to survive JSON — assert the encoding is correct, not just present.
    const img = loadPng('PIXELDATA_roundtrip');
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({ model: 'gpt-4o', prompt: 'p', params: {}, images: [img] });

    const url = asParts(userContent(calls[0]!)).find((p) => p.type === 'image_url')!.image_url!.url!;
    const base64 = url.slice(url.indexOf(',') + 1);
    const decoded = new Uint8Array(Buffer.from(base64, 'base64'));
    expect(Buffer.from(decoded).equals(Buffer.from(img.bytes))).toBe(true);
  });
});

// ===========================================================================
// AC2 / NFR-1 — a call with no images keeps today's exact wire shape; an empty
//        images list is treated as text-only (content stays a STRING, not array).
// ===========================================================================

describe('multimodal request — text-only calls are byte-for-byte unchanged (AC2 / NFR-1)', () => {
  it('sends the legacy single-string content message when there are no images', async () => {
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({ model: 'gpt-4o-mini', prompt: 'just text', params: {} });

    const content = userContent(calls[0]!);
    expect(typeof content).toBe('string');
    expect(content).toBe('just text');
    // Byte-for-byte legacy shape: messages is exactly the pre-WI-415 structure.
    expect(jsonBody(calls[0]!).messages).toEqual([{ role: 'user', content: 'just text' }]);
  });

  it('treats an empty images array as text-only (no content-parts array)', async () => {
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({ model: 'gpt-4o-mini', prompt: 'still text', params: {}, images: [] });

    expect(typeof userContent(calls[0]!)).toBe('string');
    expect(jsonBody(calls[0]!).messages).toEqual([{ role: 'user', content: 'still text' }]);
  });
});

// ===========================================================================
// AC3 — the adapter reads only the text completion; an echoed/returned image in
//        the response is ignored.
// ===========================================================================

describe('multimodal response — only the text completion is read (AC3)', () => {
  it('ignores an echoed image in the response and returns just the text', async () => {
    const img = loadPng('PIXELDATA_echo');
    // The gateway echoes the image back alongside the text content.
    const echoed = {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'a sunny field',
            images: [{ url: 'data:image/png;base64,ECHOEDBACK' }],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    };
    const { fetchFn } = makeFetchStub(
      () => new Response(JSON.stringify(echoed), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-4o', prompt: 'describe', params: {}, images: [img] });

    expect(res.text).toBe('a sunny field');
    expect(res.inputTokens).toBe(20);
    expect(res.outputTokens).toBe(4);
  });
});

// ===========================================================================
// AC4 / NFR-3 — image bytes appear ONLY in the request body, never in a thrown
//        error; the API key is never leaked either.
// ===========================================================================

describe('multimodal — image bytes never leak into errors (AC4 / NFR-3)', () => {
  const MARKER = 'PIXELDATA_SECRET_DEADBEEF_7F3A';

  it('a gateway HTTP error names the status but never the image data URL, bytes, or key', async () => {
    const img = loadPng(MARKER);
    const expectedUrl = dataUrl(img);
    // 404 is non-transient → thrown immediately, AFTER the (image) body was built.
    const { fetchFn } = makeFetchStub(() => new Response('nope', { status: 404, headers: {} }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const message = await rejectionMessage(
      adapter.call({ model: 'gpt-4o', prompt: 'p', params: {}, images: [img] }),
    );

    expect(message).toContain('404'); // names the failure
    expect(message).not.toContain(expectedUrl); // the full base64 data URL never leaks
    expect(message).not.toContain(MARKER); // raw marker bytes never leak
    expect(message).not.toContain(API_KEY); // key redaction unchanged
  });

  it('puts the image bytes in the request body (proving they ARE sent on the wire)', async () => {
    const img = loadPng(MARKER);
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({ model: 'gpt-4o', prompt: 'p', params: {}, images: [img] });

    // Contrast with the error test: the encoded bytes belong in the body, only there.
    expect(String(calls[0]!.init.body)).toContain(dataUrl(img));
  });
});

// ===========================================================================
// AC5 — allow-listed param filtering and the 429/5xx bounded retry are unchanged
//        for image calls (the body-assembly branch must not bypass either).
// ===========================================================================

describe('multimodal — param filtering & retry unchanged for image calls (AC5)', () => {
  it('still drops non-allowlisted params (e.g. api_key) and keeps allowed ones on an image call', async () => {
    const img = loadPng('PIXELDATA_filter');
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({
      model: 'gpt-4o',
      prompt: 'p',
      params: { temperature: 0.5, api_key: 'sneaky', not_allowed: 'x' },
      images: [img],
    });

    const body = jsonBody(calls[0]!);
    expect(body.temperature).toBe(0.5); // allow-listed param forwarded
    expect('api_key' in body).toBe(false); // non-allowlisted dropped
    expect('not_allowed' in body).toBe(false);
  });

  it('retries a 429 then succeeds on an image call, re-sending the identical multimodal body', async () => {
    const img = loadPng('PIXELDATA_retry');
    let calledTimes = 0;
    const { fetchFn, calls } = makeFetchStub(() => {
      calledTimes += 1;
      // First attempt rate-limited, second succeeds.
      return calledTimes === 1
        ? new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } })
        : chatResponse('ok after retry');
    });
    // Inject a no-op sleep so the bounded retry does not actually wait.
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn: async () => {} });

    const res = await adapter.call({ model: 'gpt-4o', prompt: 'p', params: {}, images: [img] });

    expect(res.text).toBe('ok after retry');
    expect(calls).toHaveLength(2); // it retried
    // The retry re-sends the SAME body (the multimodal payload is reused, not rebuilt differently).
    expect(String(calls[1]!.init.body)).toBe(String(calls[0]!.init.body));
  });
});
