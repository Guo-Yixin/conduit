/**
 * Tests for the output adapter + asset tagging (WI-303 AC1, SPEC §4 output
 * adapter, SPEC §13 asset tagging / FR-13).
 *
 * FORMAT layer only (transport is a separate layer — see src/channels). The
 * adapter takes a deterministic fan-in result and produces the flow's reference
 * artifact, stamping every asset with a STABLE id. The id is the non-backfillable
 * join key for the market-feedback loop (SPEC §13 F3): it MUST be stable across
 * re-runs so it can survive every downstream hop.
 *
 * Contract this file pins for src/output/adapter.ts:
 *
 *   interface AssembledChild  { cardId: string; payload: unknown }
 *   interface AssembledResult { parentCardId: string; children: AssembledChild[] }
 *   interface TaggedAsset     { id: string; sourceCardId: string; payload: unknown }
 *   interface ReferenceArtifact { parentCardId: string; assets: TaggedAsset[] }
 *   function formatArtifact(result: AssembledResult): ReferenceArtifact
 */
import { describe, it, expect } from 'bun:test';
import { formatArtifact, type AssembledResult } from './adapter';

function assembled(overrides: Partial<AssembledResult> = {}): AssembledResult {
  return {
    parentCardId: 'epic_1',
    children: [
      { cardId: 'child_a', payload: { body: 'variant A' } },
      { cardId: 'child_b', payload: { body: 'variant B' } },
      { cardId: 'child_c', payload: { body: 'variant C' } },
    ],
    ...overrides,
  };
}

describe('formatArtifact — fan-in formatting + tagging (AC1)', () => {
  it('formats one tagged asset per assembled child, preserving the source card', () => {
    const artifact = formatArtifact(assembled());
    expect(artifact.parentCardId).toBe('epic_1');
    expect(artifact.assets).toHaveLength(3);
    expect(artifact.assets.map((a) => a.sourceCardId).sort()).toEqual(['child_a', 'child_b', 'child_c']);
    expect(artifact.assets.find((a) => a.sourceCardId === 'child_a')!.payload).toEqual({ body: 'variant A' });
  });

  it('stamps every asset with a non-empty, unique id', () => {
    const artifact = formatArtifact(assembled());
    const ids = artifact.assets.map((a) => a.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // all distinct
  });

  it('produces STABLE ids — re-formatting identical input yields identical ids', () => {
    // SPEC §13 F3: the asset id is the non-backfillable attribution key; it must
    // survive downstream hops, so it cannot churn between runs.
    const first = formatArtifact(assembled());
    const second = formatArtifact(assembled());
    expect(second.assets.map((a) => a.id)).toEqual(first.assets.map((a) => a.id));
  });

  it('canonicalizes object key order — identical content, reordered keys → SAME id', () => {
    // SPEC §13 F3: the id is the join key for market feedback. JSON.stringify
    // preserves insertion order, so reordered keys on identical content must NOT
    // churn the id, or attribution silently fractures across re-runs.
    const a = formatArtifact({
      parentCardId: 'epic_1',
      children: [{ cardId: 'child_a', payload: { headline: 'Buy now', cta: 'Shop', tags: ['sale', 'new'] } }],
    });
    const b = formatArtifact({
      parentCardId: 'epic_1',
      children: [{ cardId: 'child_a', payload: { tags: ['sale', 'new'], cta: 'Shop', headline: 'Buy now' } }],
    });
    expect(b.assets[0].id).toBe(a.assets[0].id);
  });

  it('canonicalizes NESTED object key order recursively', () => {
    const a = formatArtifact({
      parentCardId: 'epic_1',
      children: [{ cardId: 'child_a', payload: { outer: { x: 1, y: 2 }, meta: { a: 'p', b: 'q' } } }],
    });
    const b = formatArtifact({
      parentCardId: 'epic_1',
      children: [{ cardId: 'child_a', payload: { meta: { b: 'q', a: 'p' }, outer: { y: 2, x: 1 } } }],
    });
    expect(b.assets[0].id).toBe(a.assets[0].id);
  });

  it('preserves ARRAY order — reordering array elements changes the id', () => {
    // Arrays are order-significant; only object keys are canonicalized.
    const a = formatArtifact({
      parentCardId: 'epic_1',
      children: [{ cardId: 'child_a', payload: { tags: ['sale', 'new'] } }],
    });
    const b = formatArtifact({
      parentCardId: 'epic_1',
      children: [{ cardId: 'child_a', payload: { tags: ['new', 'sale'] } }],
    });
    expect(b.assets[0].id).not.toBe(a.assets[0].id);
  });

  it('genuinely different payload content produces DIFFERENT ids', () => {
    const a = formatArtifact({
      parentCardId: 'epic_1',
      children: [{ cardId: 'child_a', payload: { headline: 'Buy now' } }],
    });
    const b = formatArtifact({
      parentCardId: 'epic_1',
      children: [{ cardId: 'child_a', payload: { headline: 'Buy later' } }],
    });
    expect(b.assets[0].id).not.toBe(a.assets[0].id);
  });
});
