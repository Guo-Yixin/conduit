/**
 * Tests for the station-level `deliver` block: schema parsing, load-time
 * validation, and the pure delivery-channel resolver (WI-596, PRD "Slack Egress
 * File Delivery" §6 FR-1/2/6/8/9/13, §9 decision 6).
 *
 * CONFIG layer only — no egress send happens here. This item (a) parses a
 * station-level `deliver` block (declared files, optional thread_from substrate
 * field, optional caption) onto StationConfig, (b) validates it at load ("config
 * is validated, not trusted"), and (c) exposes a pure `resolveDeliveryChannel`
 * that mirrors the existing hitl `uses:` lookup. The executor delivery path
 * (WI-599) consumes both.
 *
 * ── Contract this file pins for src/flow/load.ts + src/types/kernel.ts ──
 *
 * 1. A station may declare a `deliver:` block. buildStationConfig parses it onto
 *    StationConfig.deliver ({ files: string[]; thread_from?: string; caption?: string }).
 *    The field is ABSENT (undefined) when no `deliver:` is declared — never an
 *    empty object (optional-field pattern of image_inputs/next/output_schema).
 *    Declared file paths are stored VERBATIM (not resolved to absolute).
 *
 * 2. loadFlow REJECTS at load (typed error naming the station):
 *      - a `deliver` block with an empty/zero-length `files` list (FR-13);
 *      - a `deliver` block on a flow with no delivery-capable egress channel —
 *        i.e. no egress at all, OR egress channels that declare `uses` but none
 *        includes `delivery` (a hitl-only egress set must not be hijacked) (FR-13).
 *    A `thread_from` naming a field the substrate can't supply is NOT a load
 *    error (FR-8, decision 6) — the same flow may be Slack- or CLI-triggered.
 *
 * 3. src/flow/load.ts MUST export `resolveDeliveryChannel(egress)` — a PURE
 *    function over the flow's egress-channel list that returns:
 *      - the channel whose `uses` includes `delivery`; else
 *      - the FIRST egress channel when NO channel declares any `uses` (fallback);
 *      - undefined when some channel declares `uses` but none includes `delivery`.
 *    It mirrors the hitl-egress derivation at load.ts:1622.
 *
 * These tests exercise the REAL loadFlow()/resolveDeliveryChannel against inline
 * flow.yaml documents and constructed channel lists.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig, StationConfig, FlowEgressChannel } from '../types/kernel';
import { loadFlow, type LoadFlowResult } from './load';
import * as loadModule from './load';

// ---------------------------------------------------------------------------
// Test scaffolding (mirrors the helper in load.test.ts / load-image-inputs.test.ts)
// ---------------------------------------------------------------------------

const STATION_ID = 'deliver-photo';

/** Write `yaml` to a throwaway temp file and load it through the REAL loader. */
function loadInline(yaml: string): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-deliver-flow-'));
  const path = join(dir, 'flow.yaml');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yaml, 'utf-8');
    return loadFlow(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Narrow to the success branch, failing the test (with detail) otherwise. */
function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

/** Narrow to the failure branch, failing the test otherwise. */
function expectErrors(result: LoadFlowResult): { code: string; message: string }[] {
  if (result.ok) {
    throw new Error('expected validation errors, but load succeeded');
  }
  return result.errors;
}

/** All error messages joined — used to assert an error "names" a given entity. */
function errorText(result: LoadFlowResult): string {
  return expectErrors(result)
    .map((e) => e.message)
    .join(' | ');
}

/** Fetch a station by id from a loaded flow, failing clearly if absent. */
function station(flow: FlowConfig, id: string): StationConfig {
  const s = flow.stations[id];
  if (s === undefined) {
    throw new Error(`station '${id}' missing from loaded flow (have: ${Object.keys(flow.stations).join(', ')})`);
  }
  return s;
}

/**
 * Compose a single-station flow with the given (already-indented) `deliver:` and
 * `channels:` YAML fragments. Fragments are inserted verbatim so each test reads
 * as the YAML a flow author would write.
 */
function flowYaml(opts: { deliver?: string; channels?: string }): string {
  return [
    'flow: delivertest',
    'flow_version: 1',
    'terminal_lanes: [done, scrap, hold]',
    opts.channels ?? '',
    'stations:',
    `  - id: ${STATION_ID}`,
    '    worker: { kind: transform }',
    opts.deliver ?? '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** An egress channel block whose single channel declares `uses: [delivery]`. */
const DELIVERY_EGRESS = `channels:
  egress:
    - type: slack
      target: "#deliveries"
      uses: [delivery]`;

/** An egress channel block whose single channel declares NO uses (fallback-capable). */
const BARE_EGRESS = `channels:
  egress:
    - type: slack
      target: "#deliveries"`;

/** An egress channel block whose only channel is hitl-only (NOT delivery-capable). */
const HITL_ONLY_EGRESS = `channels:
  egress:
    - type: operator
      target: human
      uses: [hitl]`;

/**
 * The pure delivery-channel resolver the loader must export. Read structurally so
 * this file type-checks before the export exists; requireResolver() turns an
 * absent/invalid export into a crisp RED for B.A.
 */
type DeliveryResolver = (egress: FlowEgressChannel[] | undefined) => FlowEgressChannel | undefined;
const resolveDeliveryChannel = (loadModule as { resolveDeliveryChannel?: DeliveryResolver }).resolveDeliveryChannel;

function requireResolver(): DeliveryResolver {
  if (typeof resolveDeliveryChannel !== 'function') {
    throw new Error(
      'src/flow/load.ts must export resolveDeliveryChannel(egress): FlowEgressChannel | undefined — ' +
        'the pure delivery-channel resolver mirroring the hitl uses: lookup at load.ts:1622 (FR-2).',
    );
  }
  return resolveDeliveryChannel;
}

// ===========================================================================
// AC1 — a valid deliver block parses onto StationConfig (FR-1)
// ===========================================================================

describe('loadFlow — deliver block parses onto StationConfig (AC1/FR-1)', () => {
  it('loads a flow whose station declares deliver.files and carries the declared files', () => {
    const flow = expectOk(
      loadInline(flowYaml({ channels: DELIVERY_EGRESS, deliver: '    deliver:\n      files: [work/edited.jpg]' })),
    );
    expect(station(flow, STATION_ID).deliver?.files).toEqual(['work/edited.jpg']);
  });

  it('preserves declared file paths verbatim (does NOT resolve to absolute at load)', () => {
    const flow = expectOk(
      loadInline(
        flowYaml({ channels: DELIVERY_EGRESS, deliver: '    deliver:\n      files: [work/a.jpg, out/b.png]' }),
      ),
    );
    expect(station(flow, STATION_ID).deliver?.files).toEqual(['work/a.jpg', 'out/b.png']);
  });

  it('leaves deliver undefined for a station that declares no deliver block (optional-field pattern)', () => {
    const flow = expectOk(loadInline(flowYaml({ channels: DELIVERY_EGRESS })));
    expect(station(flow, STATION_ID).deliver).toBeUndefined();
  });
});

// ===========================================================================
// AC2 — a deliver block naming zero files is rejected, naming the station (FR-13)
// ===========================================================================

describe('loadFlow — zero-file deliver block is rejected (AC2/FR-13)', () => {
  it.each([
    ['an explicitly empty files list', '    deliver:\n      files: []'],
    ['a deliver block with no files key', '    deliver:\n      caption: "here you go"'],
  ])('rejects %s with a typed error naming the station', (_label, deliver) => {
    const result = loadInline(flowYaml({ channels: DELIVERY_EGRESS, deliver }));
    // It is a load-time validation failure…
    expect(result.ok).toBe(false);
    // …and the error names the offending station (FR-13: "naming the station").
    expect(errorText(result)).toContain(STATION_ID);
  });
});

// ===========================================================================
// AC3 — optional thread_from + caption parse when present, absent when omitted;
//        thread_from is NOT a load error even if no substrate could supply it
//        (FR-6/FR-8, decision 6)
// ===========================================================================

describe('loadFlow — optional thread_from + caption on the deliver block (AC3)', () => {
  it('parses thread_from and caption onto StationConfig when present', () => {
    const flow = expectOk(
      loadInline(
        flowYaml({
          channels: DELIVERY_EGRESS,
          deliver: '    deliver:\n      files: [work/edited.jpg]\n      thread_from: thread_ts\n      caption: "here is your edit"',
        }),
      ),
    );
    const deliver = station(flow, STATION_ID).deliver;
    expect(deliver?.files).toEqual(['work/edited.jpg']);
    expect(deliver?.thread_from).toBe('thread_ts');
    expect(deliver?.caption).toBe('here is your edit');
  });

  it('leaves thread_from and caption undefined when omitted', () => {
    const flow = expectOk(
      loadInline(flowYaml({ channels: DELIVERY_EGRESS, deliver: '    deliver:\n      files: [work/edited.jpg]' })),
    );
    const deliver = station(flow, STATION_ID).deliver;
    expect(deliver?.thread_from).toBeUndefined();
    expect(deliver?.caption).toBeUndefined();
  });

  it('does NOT reject a thread_from the substrate cannot supply (FR-8, decision 6) — loads on a CLI flow', () => {
    // No ingress binding could supply `thread_ts` here, yet load must still succeed:
    // the same flow may be Slack- or CLI-triggered; a missing address is a runtime
    // degrade (FR-8), not a load error.
    const flow = expectOk(
      loadInline(
        flowYaml({
          channels: DELIVERY_EGRESS,
          deliver: '    deliver:\n      files: [work/edited.jpg]\n      thread_from: no_such_field',
        }),
      ),
    );
    expect(station(flow, STATION_ID).deliver?.thread_from).toBe('no_such_field');
  });
});

// ===========================================================================
// Regression (Amy REJECT) — deliver FIELD TYPES are validated at load
// ("config is validated, not trusted"). Mirrors the same-file precedent for
// INVALID_IMAGE_INPUT_ENTRY (every image input has a string `path`) and
// INVALID_PREREQUISITES (every entry is a string): a non-string `files` entry,
// or a non-string `caption`/`thread_from`, must be REJECTED at load — never
// cast blindly (`as string`) and shipped into the parsed StationConfig for
// WI-599's executor (which reads files as paths and caption/thread_from as
// strings) to trip over at runtime.
// ===========================================================================

describe('loadFlow — deliver field types are validated (Amy regression, config-not-trusted)', () => {
  it.each([
    ['a number', '[42]'],
    ['a boolean', '[true]'],
    ['an object', '[{ evil: 1 }]'],
    ['a valid path mixed with a non-string', '[work/ok.jpg, 42]'],
  ])('rejects deliver.files containing %s with a typed error naming the station', (_label, filesLiteral) => {
    const result = loadInline(
      flowYaml({ channels: DELIVERY_EGRESS, deliver: `    deliver:\n      files: ${filesLiteral}` }),
    );
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain(STATION_ID);
  });

  it.each([
    ['a number', '12345'],
    ['an object', '{ nested: true }'],
    ['a boolean', 'true'],
  ])('rejects a non-string deliver.caption (%s) with a typed error naming the station', (_label, captionLiteral) => {
    const result = loadInline(
      flowYaml({
        channels: DELIVERY_EGRESS,
        deliver: `    deliver:\n      files: [work/edited.jpg]\n      caption: ${captionLiteral}`,
      }),
    );
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain(STATION_ID);
  });

  it.each([
    ['a number', '42'],
    ['an object', '{ nested: true }'],
  ])('rejects a non-string deliver.thread_from (%s) with a typed error naming the station', (_label, threadLiteral) => {
    const result = loadInline(
      flowYaml({
        channels: DELIVERY_EGRESS,
        deliver: `    deliver:\n      files: [work/edited.jpg]\n      thread_from: ${threadLiteral}`,
      }),
    );
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain(STATION_ID);
  });
});

// ===========================================================================
// Review MEDIUM — deliver.files must be confined to the project root (egress
//       containment): an absolute or `..`-escaping literal is rejected at load
//       (SPEC §7). The executor also symlink-resolves at runtime.
// ===========================================================================

describe('loadFlow — deliver.files project-root containment (DELIVER_FILE_ESCAPES_ROOT)', () => {
  it.each([
    ['an absolute path', '[/etc/passwd]'],
    ['a parent-dir escape', '[../../../home/user/.aws/credentials]'],
    ['a valid path mixed with an escape', '[work/ok.jpg, ../../secret.env]'],
  ])('rejects deliver.files containing %s with DELIVER_FILE_ESCAPES_ROOT naming the station', (_label, filesLiteral) => {
    const result = loadInline(
      flowYaml({ channels: DELIVERY_EGRESS, deliver: `    deliver:\n      files: ${filesLiteral}` }),
    );
    expect(result.ok).toBe(false);
    expect(expectErrors(result).map((e) => e.code)).toContain('DELIVER_FILE_ESCAPES_ROOT');
    expect(errorText(result)).toContain(STATION_ID);
  });

  it('accepts an ordinary project-root-relative path', () => {
    const flow = expectOk(
      loadInline(
        flowYaml({ channels: DELIVERY_EGRESS, deliver: '    deliver:\n      files: [work/nested/edited.jpg]' }),
      ),
    );
    expect(station(flow, STATION_ID).deliver?.files).toEqual(['work/nested/edited.jpg']);
  });
});

// ===========================================================================
// AC4 — resolveDeliveryChannel: pure uses:[delivery] lookup with fallback (FR-2)
// ===========================================================================

describe('resolveDeliveryChannel — pure delivery-channel lookup (AC4/FR-2)', () => {
  it('returns the egress channel whose uses includes delivery', () => {
    const resolve = requireResolver();
    const delivery: FlowEgressChannel = { type: 'slack', target: '#deliveries', uses: ['delivery'] };
    expect(resolve([delivery])).toBe(delivery);
  });

  it('finds the delivery channel by its use, not by position', () => {
    const resolve = requireResolver();
    const hitl: FlowEgressChannel = { type: 'operator', target: 'human', uses: ['hitl'] };
    const delivery: FlowEgressChannel = { type: 'slack', target: '#deliveries', uses: ['delivery'] };
    // delivery is second AND hitl is first — the resolver must pick delivery, not hitl.
    expect(resolve([hitl, delivery])).toBe(delivery);
  });

  it('returns the FIRST egress channel when no channel declares any uses (fallback)', () => {
    const resolve = requireResolver();
    const first: FlowEgressChannel = { type: 'slack', target: '#first' };
    const second: FlowEgressChannel = { type: 'slack', target: '#second' };
    expect(resolve([first, second])).toBe(first);
  });

  it.each([
    ['a hitl-only egress set', [{ type: 'operator', target: 'human', uses: ['hitl'] }]],
    ['uses declared but none is delivery', [
      { type: 'operator', target: 'human', uses: ['hitl'] },
      { type: 'slack', target: '#notify', uses: ['notify'] },
    ]],
    ['no egress channels (empty list)', []],
  ] as [string, FlowEgressChannel[]][])(
    'returns undefined for %s',
    (_label, egress) => {
      expect(requireResolver()(egress)).toBeUndefined();
    },
  );

  it('returns undefined when the egress list is absent (undefined)', () => {
    expect(requireResolver()(undefined)).toBeUndefined();
  });
});

// ===========================================================================
// AC5 — loadFlow rejects a deliver block with no delivery-capable egress channel
//        (FR-13, edge case "Channel declares uses:[hitl] only")
// ===========================================================================

describe('loadFlow — deliver requires a delivery-capable egress channel (AC5/FR-13)', () => {
  const DELIVER = '    deliver:\n      files: [work/edited.jpg]';

  it('rejects a deliver block when the flow declares no egress channel, naming the station', () => {
    const result = loadInline(flowYaml({ deliver: DELIVER })); // no channels: block at all
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain(STATION_ID);
  });

  it('rejects a deliver block when egress declares uses but none includes delivery (hitl-only not hijacked)', () => {
    const result = loadInline(flowYaml({ channels: HITL_ONLY_EGRESS, deliver: DELIVER }));
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain(STATION_ID);
  });

  it('accepts a deliver block when a channel declares uses:[delivery]', () => {
    const flow = expectOk(loadInline(flowYaml({ channels: DELIVERY_EGRESS, deliver: DELIVER })));
    expect(station(flow, STATION_ID).deliver?.files).toEqual(['work/edited.jpg']);
  });

  it('accepts a deliver block when the sole egress channel declares no uses (fallback is delivery-capable)', () => {
    const flow = expectOk(loadInline(flowYaml({ channels: BARE_EGRESS, deliver: DELIVER })));
    expect(station(flow, STATION_ID).deliver?.files).toEqual(['work/edited.jpg']);
  });
});
