/**
 * HITL reply routing from Slack (the original HITL reply-and-resume work FR-3) — the two inbound paths that
 * turn a human's channel gesture into applyHitlReply:
 *
 *   routeHitlThreadReply    — a plain message replying in a posted ask's thread
 *                             (matched via the kernel-journaled `hitl.ask` span)
 *   processSlackInteractive — a button tap whose action_id round-trips the
 *                             correlation id (socket `interactive` envelopes)
 *
 * Everything below runs against a REAL in-memory ConduitDB: the held card, the
 * card_log correlation surface, the hitl.ask span, and the applyHitlReply
 * status flip are the actual persistence discipline, not fakes. Only Slack
 * itself is absent — these functions never touch the network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../../persistence/db';
import { getRecordedHitlSelection, applyHitlReply } from '../../channels/slack';
import { routeHitlThreadReply, processSlackInteractive, resumeAfterHitlReply } from './slack-events';

const RUN = DEFAULT_RUN_ID;
const CARD = 'root';
const STATION = 'select';
const CORRELATION = `hitl::${CARD}::${STATION}::0`;
const ASK_TS = '1784200000.000100';
const SHORT_LIST = ['Cotton Candy Reef', 'Bubblegum Beach', 'Berry Fizz'];

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  // A held card at the rank station, exactly as executeRankStation parks it:
  db.insertCard({
    run_id: RUN,
    id: CARD,
    parent_id: null,
    lane: STATION,
    status: 'held',
    attempt: 0,
    wave: 0,
    owned_paths: [],
  });
  // ... with the correlation id surfaced on the card_log (WI-398) ...
  db.appendCardLog({
    runId: RUN,
    kind: 'terminal',
    cardId: CARD,
    station: STATION,
    attempt: 0,
    reason: CORRELATION,
  });
  // ... and the ask's thread address journaled (the original HITL reply-and-resume work FR-3b).
  db.appendJournalSpan({
    runId: RUN,
    cardId: CARD,
    station: STATION,
    attempt: 0,
    name: 'hitl.ask',
    attributes: {
      correlation_id: CORRELATION,
      channel: 'C0STUDIO',
      ts: ASK_TS,
      short_list: SHORT_LIST,
    },
  });
});

afterEach(() => db.close());

function cardStatus(): string {
  return (db.getCard(RUN, CARD) as { status: string }).status;
}

function threadReplyBody(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    event_id: 'Ev-reply-1',
    event: { type: 'message', text, thread_ts: ASK_TS, channel: 'C0STUDIO', user: 'U1', ...extra },
  };
}

describe('routeHitlThreadReply (the original HITL reply-and-resume work FR-3b)', async () => {
  it('a 1-based index reply selects that shortlist entry and un-holds the card', async () => {
    const routed = await routeHitlThreadReply(db, threadReplyBody('2'));
    expect(routed).toBe(true);
    expect(cardStatus()).toBe('ready');
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Bubblegum Beach');
  });

  it('an exact label reply (case-insensitive) selects it', async () => {
    const routed = await routeHitlThreadReply(db, threadReplyBody('berry fizz'));
    expect(routed).toBe(true);
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Berry Fizz');
  });

  it('an unparsable reply is consumed (never spawns) but selects NOTHING — the card stays held', async () => {
    const routed = await routeHitlThreadReply(db, threadReplyBody('the sparkly one'));
    expect(routed).toBe(true); // it WAS addressed at our ask — not a trigger
    expect(cardStatus()).toBe('held');
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBeNull();
    const rejected = db.getIngressLog({ outcome: 'rejected_malformed' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain('did not resolve to a candidate');
  });

  it('an out-of-range index is rejected the same way (1-based, bounded)', async () => {
    expect(await routeHitlThreadReply(db, threadReplyBody('4'))).toBe(true);
    expect(await routeHitlThreadReply(db, threadReplyBody('0'))).toBe(true);
    expect(cardStatus()).toBe('held');
  });

  it('a second reply after the first selection is journaled as duplicate, not re-applied', async () => {
    await routeHitlThreadReply(db, threadReplyBody('1'));
    await routeHitlThreadReply(db, threadReplyBody('3'));
    // First reply wins (PRD: later taps get "already recorded").
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Cotton Candy Reef');
    expect(db.getIngressLog({ outcome: 'duplicate' })).toHaveLength(1);
  });

  it("an '=' prefixed reply records a FREE-FORM override not on the shortlist", async () => {
    const routed = await routeHitlThreadReply(db, threadReplyBody('= Watermelon Fizz'));
    expect(routed).toBe(true);
    expect(cardStatus()).toBe('ready');
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Watermelon Fizz');
  });

  it("a bare '=' (empty override) is rejected — never an empty selection", async () => {
    expect(await routeHitlThreadReply(db, threadReplyBody('='))).toBe(true);
    expect(cardStatus()).toBe('held');
  });

  it.each([
    ['a bot-authored reply', threadReplyBody('2', { bot_id: 'B123' })],
    ['a top-level message (no thread_ts)', { event: { type: 'message', text: '2', channel: 'C0STUDIO' } }],
    ['a reply in an unrelated thread', { event: { type: 'message', text: '2', thread_ts: '999.111' } }],
    ['a non-message event', { event: { type: 'reaction_added', thread_ts: ASK_TS } }],
    ['a non-object body', 'garbage'],
  ])('%s is NOT routed (falls through to the trigger pipeline)', async (_label, body) => {
    expect(await routeHitlThreadReply(db, body)).toBe(false);
    expect(cardStatus()).toBe('held');
  });
});

describe('routeHitlThreadReply — multiple asks on one thread root (Fix 4)', async () => {
  const CARD2 = 'sibling';
  const CORRELATION2 = `hitl::${CARD2}::${STATION}::0`;
  const SHORT_LIST2 = ['Alpha Swirl', 'Beta Blast'];

  // A second held card that parked its OWN rank+HITL under the SAME thread root
  // — exactly the fan-out shape where each child asks on the triggering ts.
  function addSecondAsk(): void {
    db.insertCard({
      run_id: RUN,
      id: CARD2,
      parent_id: null,
      lane: STATION,
      status: 'held',
      attempt: 0,
      wave: 0,
      owned_paths: [],
    });
    db.appendCardLog({ runId: RUN, kind: 'terminal', cardId: CARD2, station: STATION, attempt: 0, reason: CORRELATION2 });
    db.appendJournalSpan({
      runId: RUN,
      cardId: CARD2,
      station: STATION,
      attempt: 0,
      name: 'hitl.ask',
      attributes: { correlation_id: CORRELATION2, channel: 'C0STUDIO', ts: ASK_TS, short_list: SHORT_LIST2 },
    });
  }

  function statusOf(cardId: string): string {
    return (db.getCard(RUN, cardId) as { status: string }).status;
  }

  it('two live asks on one thread root → a bare reply is rejected_ambiguous, neither card flips', async () => {
    addSecondAsk();
    const routed = await routeHitlThreadReply(db, threadReplyBody('1'));
    expect(routed).toBe(true); // it WAS in our ask thread — never a trigger
    expect(statusOf(CARD)).toBe('held');
    expect(statusOf(CARD2)).toBe('held');
    const rejected = db.getIngressLog({ outcome: 'rejected_ambiguous' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain('ambiguous');
    // Never guessed the newest — no selection recorded on either card.
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBeNull();
    expect(getRecordedHitlSelection(db, CARD2, RUN)).toBeNull();
    // And it was NOT mis-journaled as ordinary malformed chatter.
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(0);
  });

  it('an ambiguous reply does NOT invoke the resume hook', async () => {
    addSecondAsk();
    const resumed: string[] = [];
    await routeHitlThreadReply(db, threadReplyBody('1'), (r) => { resumed.push(r); });
    expect(resumed).toEqual([]);
  });

  it('one live ask + one already-answered ask on the same root → a bare reply resolves to the LIVE ask', async () => {
    addSecondAsk();
    // Answer the sibling ask: its correlation id now carries a hitl.selection span.
    const done = applyHitlReply(db, CORRELATION2, 'Alpha Swirl', RUN);
    expect(done.resumed).toBe(true);
    // A bare "1" now unambiguously targets the still-held original ask.
    const routed = await routeHitlThreadReply(db, threadReplyBody('1'));
    expect(routed).toBe(true);
    expect(cardStatus()).toBe('ready');
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Cotton Candy Reef');
    expect(db.getIngressLog({ outcome: 'rejected_ambiguous' })).toHaveLength(0);
  });

  it('all asks answered on the root → a late bare reply still routes (journaled duplicate, not dropped)', async () => {
    addSecondAsk();
    // Answer both asks, then reply again — no live asks remain.
    applyHitlReply(db, CORRELATION, 'Cotton Candy Reef', RUN);
    applyHitlReply(db, CORRELATION2, 'Alpha Swirl', RUN);
    const routed = await routeHitlThreadReply(db, threadReplyBody('2'));
    expect(routed).toBe(true); // still recognized as our thread, not a trigger
    expect(db.getIngressLog({ outcome: 'duplicate' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'rejected_ambiguous' })).toHaveLength(0);
  });

  // the pre-public ingress-deduplication review: findHitlAskByThreadTs's answered-set lookup was restricted
  // from an unfiltered `hitl.selection` scan to only the correlation ids
  // relevant to this thread root. Pin that the restriction doesn't drop any
  // answered id it should still see, even with a large, unrelated journal.
  it('resolves correctly amid many unrelated hitl.selection spans from other threads/runs', async () => {
    addSecondAsk();
    for (let i = 0; i < 50; i++) {
      db.appendJournalSpan({
        runId: `other-run-${i}`,
        cardId: `other-card-${i}`,
        station: STATION,
        attempt: 0,
        name: 'hitl.selection',
        attributes: { correlation_id: `hitl::other-card-${i}::${STATION}::0` },
      });
    }
    // Answer only the sibling ask — the original ask stays live.
    const done = applyHitlReply(db, CORRELATION2, 'Alpha Swirl', RUN);
    expect(done.resumed).toBe(true);
    const routed = await routeHitlThreadReply(db, threadReplyBody('1'));
    expect(routed).toBe(true);
    expect(cardStatus()).toBe('ready');
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Cotton Candy Reef');
    expect(db.getIngressLog({ outcome: 'rejected_ambiguous' })).toHaveLength(0);
  });
});

describe('routeHitlThreadReply — subtyped / empty thread chatter (Fix 8)', async () => {
  it('a message_changed subtype in our ask thread is consumed silently — no rejected_malformed, no flip', async () => {
    const routed = await routeHitlThreadReply(
      db,
      threadReplyBody('2', { subtype: 'message_changed' }),
    );
    expect(routed).toBe(true); // in our thread — never a trigger
    expect(cardStatus()).toBe('held');
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_ambiguous' })).toHaveLength(0);
  });

  it('an empty-text message in our ask thread is consumed silently — no rejection journal', async () => {
    const routed = await routeHitlThreadReply(db, threadReplyBody('   '));
    expect(routed).toBe(true);
    expect(cardStatus()).toBe('held');
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(0);
  });

  it('a channel_join subtype (no text) in our ask thread produces no rejection journal', async () => {
    const routed = await routeHitlThreadReply(db, {
      event: { type: 'message', subtype: 'channel_join', thread_ts: ASK_TS, channel: 'C0STUDIO' },
    });
    expect(routed).toBe(true);
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(0);
  });

  it('a normal (no-subtype, non-empty) reply is unaffected — still routes and un-holds', async () => {
    const routed = await routeHitlThreadReply(db, threadReplyBody('2'));
    expect(routed).toBe(true);
    expect(cardStatus()).toBe('ready');
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Bubblegum Beach');
  });
});

describe('processSlackInteractive (the original HITL reply-and-resume work FR-3a)', async () => {
  function tap(actionId: string, value: string): unknown {
    return { type: 'block_actions', actions: [{ action_id: actionId, value }], user: { id: 'U1' } };
  }

  it('a button tap whose action_id is the correlation id records the value and un-holds the card', async () => {
    await processSlackInteractive(db, tap(CORRELATION, 'Bubblegum Beach'));
    expect(cardStatus()).toBe('ready');
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Bubblegum Beach');
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(1);
  });

  it('a tap for an unknown correlation id is refused, never guessed at', async () => {
    await processSlackInteractive(db, tap('hitl::other-card::x::0', 'anything'));
    expect(cardStatus()).toBe('held');
    const rejected = db.getIngressLog({ outcome: 'rejected_malformed' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain('no run recorded');
  });

  it('a non-HITL action_id (someone else\'s button) is refused without touching any card', async () => {
    await processSlackInteractive(db, tap('open-dashboard', 'x'));
    expect(cardStatus()).toBe('held');
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
  });

  it('a second tap after the first is journaled duplicate — first confirmed pick wins', async () => {
    await processSlackInteractive(db, tap(CORRELATION, 'Berry Fizz'));
    await processSlackInteractive(db, tap(CORRELATION, 'Cotton Candy Reef'));
    expect(getRecordedHitlSelection(db, CARD, RUN)).toBe('Berry Fizz');
    expect(db.getIngressLog({ outcome: 'duplicate' })).toHaveLength(1);
  });

  it('malformed payloads (non-object, no actions) are journaled, never thrown', async () => {
    await processSlackInteractive(db, null);
    await processSlackInteractive(db, { type: 'block_actions' });
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(2);
  });
});


describe('resume-after-reply (the original HITL reply-and-resume work — the loop actually closes)', () => {
  it('a successful thread reply invokes the resume hook with the run id', async () => {
    const resumed: string[] = [];
    await routeHitlThreadReply(db, threadReplyBody('2'), (runId) => {
      resumed.push(runId);
    });
    expect(resumed).toEqual([RUN]);
  });

  it('a rejected reply and a duplicate reply do NOT invoke the hook', async () => {
    const resumed: string[] = [];
    await routeHitlThreadReply(db, threadReplyBody('not a pick'), (r) => { resumed.push(r); });
    await routeHitlThreadReply(db, threadReplyBody('1')); // consumes the hold (no hook)
    await routeHitlThreadReply(db, threadReplyBody('2'), (r) => { resumed.push(r); }); // duplicate
    expect(resumed).toEqual([]);
  });

  it('a successful interactive tap invokes the hook with the resolved run id', async () => {
    const resumed: string[] = [];
    await processSlackInteractive(
      db,
      { type: 'block_actions', actions: [{ action_id: CORRELATION, value: 'Berry Fizz' }] },
      (r) => { resumed.push(r); },
    );
    expect(resumed).toEqual([RUN]);
  });

  it('resumeAfterHitlReply spawns conduit resume with the ingress-attributed flow path', async () => {
    // Attribute the run the way runSpawnPath does at accept time.
    db.acceptIngressEvent('Ev-77', 1784200000000, {
      flowId: 'studio',
      flowPath: '/repo/flows/studio/flow.yaml',
      runId: RUN,
      substrateJson: '{}',
    });

    const spawned: Array<{ flowPath: string; runId: string }> = [];
    await resumeAfterHitlReply(db, RUN, async (req) => {
      spawned.push(req);
      return { ok: true };
    });
    expect(spawned).toEqual([{ flowPath: '/repo/flows/studio/flow.yaml', runId: RUN }]);
    expect(db.getIngressLog({ outcome: 'accepted' }).some((e) => e.reason?.includes('resume spawned'))).toBe(true);
  });

  it('a run with NO ingress attribution journals the manual-resume instruction, never guesses a flow path', async () => {
    const spawned: unknown[] = [];
    await resumeAfterHitlReply(db, 'cli-run-1', async (req) => {
      spawned.push(req);
      return { ok: true };
    });
    expect(spawned).toEqual([]);
    const logs = db.getIngressLog({ outcome: 'rejected_malformed' });
    expect(logs.some((e) => e.reason?.includes('resume manually'))).toBe(true);
  });

  it('a failed resume spawn is journaled spawn_failed with the error, named', async () => {
    db.acceptIngressEvent('Ev-78', 1784200000000, {
      flowId: 'studio',
      flowPath: '/repo/flows/studio/flow.yaml',
      runId: RUN,
      substrateJson: '{}',
    });
    await resumeAfterHitlReply(db, RUN, async () => ({ ok: false, error: 'exit 1' }));
    const logs = db.getIngressLog({ outcome: 'spawn_failed' });
    expect(logs.some((e) => e.reason?.includes('exit 1'))).toBe(true);
  });
});
