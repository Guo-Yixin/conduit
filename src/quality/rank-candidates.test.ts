/**
 * Flow-computed rank candidates (the original HITL reply-and-resume work FR-1) — pure units.
 *
 * decideFromCandidates mirrors runRankCheck's post-critic routing with NO
 * model call: the RankDecision type still has no 'selected' variant, so the
 * structural no-auto-pick guarantee (WI-398 NFR-3) is inherited, not re-argued.
 * parseCandidatesArtifact pins the narrow artifact contract: a JSON array of
 * strings or {id, label} objects — anything else is null (fail-closed; the
 * executor escalates to hold rather than presenting a garbled board).
 */
import { describe, it, expect } from 'bun:test';
import { decideFromCandidates, parseCandidatesArtifact } from './rank';

describe('decideFromCandidates — routing (the original HITL reply-and-resume work)', () => {
  const CANDIDATES = ['Cotton Candy Reef', 'Bubblegum Beach', 'Berry Fizz'];

  it('hitlEnabled → await_selection carrying the candidates verbatim, in order', () => {
    const d = decideFromCandidates({
      candidates: CANDIDATES,
      hitlEnabled: true,
      noSelectionPolicy: 'scrap',
    });
    expect(d.action).toBe('await_selection');
    if (d.action !== 'await_selection') throw new Error('unreachable');
    expect(d.shortList).toEqual(CANDIDATES);
    // No model ran — the usage accounting must say so honestly.
    expect(d.output.usage).toEqual({ tokens: 0, cost: 0 });
    // rank never drives a back-edge itself (same contract as runRankCheck).
    expect(d.output.return_to).toBeNull();
  });

  it('no HITL + proceed_with_findings → proceed, shortList intact', () => {
    const d = decideFromCandidates({
      candidates: CANDIDATES,
      hitlEnabled: false,
      noSelectionPolicy: 'proceed_with_findings',
    });
    expect(d.action).toBe('proceed_with_findings');
    if (d.action !== 'proceed_with_findings') throw new Error('unreachable');
    expect(d.shortList).toEqual(CANDIDATES);
  });

  it('no HITL + scrap → scrap(no_selection) — never an auto-pick', () => {
    const d = decideFromCandidates({
      candidates: CANDIDATES,
      hitlEnabled: false,
      noSelectionPolicy: 'scrap',
    });
    expect(d).toEqual({ action: 'scrap', reason: 'no_selection' });
  });

  it('EMPTY candidates follow the no-selection policy even when HITL is wired (nothing to present)', () => {
    const scrapped = decideFromCandidates({
      candidates: [],
      hitlEnabled: true,
      noSelectionPolicy: 'scrap',
    });
    expect(scrapped).toEqual({ action: 'scrap', reason: 'no_selection' });

    const proceeded = decideFromCandidates({
      candidates: [],
      hitlEnabled: true,
      noSelectionPolicy: 'proceed_with_findings',
    });
    expect(proceeded.action).toBe('proceed_with_findings');
  });

  it('findings hash tracks the candidate list — a reworked board is progress, an identical one is not', () => {
    const a1 = decideFromCandidates({ candidates: ['x', 'y'], hitlEnabled: true, noSelectionPolicy: 'scrap' });
    const a2 = decideFromCandidates({ candidates: ['x', 'y'], hitlEnabled: true, noSelectionPolicy: 'scrap' });
    const b = decideFromCandidates({ candidates: ['x', 'z'], hitlEnabled: true, noSelectionPolicy: 'scrap' });
    if (a1.action !== 'await_selection' || a2.action !== 'await_selection' || b.action !== 'await_selection') {
      throw new Error('unreachable');
    }
    expect(a1.output.findings_hash).toBe(a2.output.findings_hash);
    expect(a1.output.findings_hash).not.toBe(b.output.findings_hash);
  });
});

describe('parseCandidatesArtifact — the narrow artifact contract (the original HITL reply-and-resume work)', () => {
  it('accepts a JSON array of strings, trimming whitespace', () => {
    expect(parseCandidatesArtifact('["One", "  Two  "]')).toEqual(['One', 'Two']);
  });

  it('accepts {id, label} objects, preferring label over id', () => {
    expect(
      parseCandidatesArtifact('[{"id": "c1", "label": "Cotton Candy Reef"}, {"id": "c2"}]'),
    ).toEqual(['Cotton Candy Reef', 'c2']);
  });

  it('accepts an empty array (the executor routes it via policy, not here)', () => {
    expect(parseCandidatesArtifact('[]')).toEqual([]);
  });

  it.each([
    ['not JSON at all', 'nope{'],
    ['a JSON object, not an array', '{"names": ["x"]}'],
    ['an empty-string entry', '["ok", "  "]'],
    ['a numeric entry', '["ok", 3]'],
    ['an object with neither label nor id', '[{"title": "x"}]'],
    ['a nested array entry', '[["x"]]'],
  ])('rejects %s as null (fail-closed)', (_label, raw) => {
    expect(parseCandidatesArtifact(raw)).toBeNull();
  });
});

describe('parseCandidatesArtifact — hardening (Fix 6)', () => {
  it('accepts an array exactly at the cap (boundary passes)', () => {
    const atCap = Array.from({ length: 50 }, (_, i) => `Candidate ${i}`);
    expect(parseCandidatesArtifact(JSON.stringify(atCap))).toEqual(atCap);
  });

  it('rejects an over-cap array as null (a giant board must not join into one ask)', () => {
    const overCap = Array.from({ length: 51 }, (_, i) => `Candidate ${i}`);
    expect(parseCandidatesArtifact(JSON.stringify(overCap))).toBeNull();
  });

  it('rejects exact duplicate labels as null (a reply naming that label is ambiguous)', () => {
    expect(parseCandidatesArtifact('["Berry Fizz", "Bubblegum", "Berry Fizz"]')).toBeNull();
  });

  it('rejects case-differing duplicate labels as null (case-folded match)', () => {
    expect(parseCandidatesArtifact('["Berry Fizz", "berry fizz"]')).toBeNull();
  });

  it('rejects duplicate labels drawn from {id, label} objects too', () => {
    expect(
      parseCandidatesArtifact('[{"label": "Reef"}, {"id": "reef"}]'),
    ).toBeNull();
  });

  it('still accepts distinct labels that only share a prefix', () => {
    expect(parseCandidatesArtifact('["Berry Fizz", "Berry Blast"]')).toEqual([
      'Berry Fizz',
      'Berry Blast',
    ]);
  });
});
