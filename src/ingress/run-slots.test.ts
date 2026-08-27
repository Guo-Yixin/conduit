/**
 * Tests for the run-slot gate (the original listener-backpressure work — listener run backpressure).
 *
 * Contract pinned here:
 *   - capacity bounds concurrent 'acquired' results; excess ids get 'full';
 *   - an id already in flight gets 'duplicate' (never a second slot) — this is
 *     the id-level mutual exclusion between the hot path and the sweep;
 *   - release frees exactly the released id's slot, is idempotent, and never
 *     frees a slot for an id that was not in flight;
 *   - onRelease fires after the slot is freed (a kicked sweep must observe the
 *     freed capacity) and only for genuine releases;
 *   - omitted capacity = Infinity: never 'full', but in-flight dedup still on.
 */
import { describe, it, expect } from 'bun:test';
import { createRunSlots } from './run-slots';

describe('createRunSlots', () => {
  it('bounds concurrent acquisitions at capacity', () => {
    const slots = createRunSlots({ capacity: 2 });
    expect(slots.tryAcquire('a')).toBe('acquired');
    expect(slots.tryAcquire('b')).toBe('acquired');
    expect(slots.tryAcquire('c')).toBe('full');
    expect(slots.inFlightCount()).toBe(2);
  });

  it('returns duplicate for an id already in flight — even when capacity remains', () => {
    const slots = createRunSlots({ capacity: 5 });
    expect(slots.tryAcquire('a')).toBe('acquired');
    expect(slots.tryAcquire('a')).toBe('duplicate');
    expect(slots.inFlightCount()).toBe(1);
  });

  it('reports duplicate (not full) for an in-flight id at capacity', () => {
    // The distinction matters: the sweep treats 'full' as "stop, no slots"
    // but must simply SKIP an in-flight row and keep scanning.
    const slots = createRunSlots({ capacity: 1 });
    slots.tryAcquire('a');
    expect(slots.tryAcquire('a')).toBe('duplicate');
    expect(slots.tryAcquire('b')).toBe('full');
  });

  it('release frees the slot for reuse', () => {
    const slots = createRunSlots({ capacity: 1 });
    slots.tryAcquire('a');
    slots.release('a');
    expect(slots.tryAcquire('b')).toBe('acquired');
  });

  it('release is idempotent and ignores ids that are not in flight', () => {
    const slots = createRunSlots({ capacity: 1 });
    slots.tryAcquire('a');
    slots.release('ghost'); // must NOT free a's slot
    expect(slots.tryAcquire('b')).toBe('full');
    slots.release('a');
    slots.release('a'); // second release: no-op
    expect(slots.tryAcquire('b')).toBe('acquired');
    expect(slots.tryAcquire('c')).toBe('full');
  });

  it('fires onRelease after the slot is freed, only for genuine releases', () => {
    const observed: number[] = [];
    const slots = createRunSlots({
      capacity: 1,
      onRelease: () => observed.push(slots.inFlightCount()),
    });
    slots.tryAcquire('a');
    slots.release('a');
    slots.release('a'); // idempotent no-op — must not re-fire
    slots.release('ghost'); // not in flight — must not fire
    expect(observed).toEqual([0]); // fired once, AFTER the slot was freed
  });

  it('tracks inFlight per id', () => {
    const slots = createRunSlots({ capacity: 2 });
    slots.tryAcquire('a');
    expect(slots.inFlight('a')).toBe(true);
    expect(slots.inFlight('b')).toBe(false);
    slots.release('a');
    expect(slots.inFlight('a')).toBe(false);
  });

  it('defaults to unlimited capacity but still dedups in-flight ids', () => {
    const slots = createRunSlots();
    expect(slots.capacity).toBe(Infinity);
    for (let i = 0; i < 1000; i++) {
      expect(slots.tryAcquire(`e${i}`)).toBe('acquired');
    }
    expect(slots.tryAcquire('e0')).toBe('duplicate');
  });

  it('rejects a non-positive or non-integer capacity at construction', () => {
    expect(() => createRunSlots({ capacity: 0 })).toThrow();
    expect(() => createRunSlots({ capacity: -1 })).toThrow();
    expect(() => createRunSlots({ capacity: 1.5 })).toThrow();
  });
});
