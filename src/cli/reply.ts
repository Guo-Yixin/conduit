/**
 * conduit reply CLI command — inject a human selection into a held card (WI-394).
 *
 * SPEC §4A, FR8/FR9. Maps a human selection (by correlation id) to the matching
 * held card, durably records the selection via applyHitlReply, and refuses
 * unknown or unparseable correlation ids. The command ONLY records the selection;
 * it does not itself resume the run.
 *
 * Usage: conduit reply --correlation-id <id> --selection <choice> [--run <id>]
 *
 * The correlation id (`hitl::<cardId>::<nonce>`) carries NO run id, so the run
 * must be supplied via --run; it defaults to the default run for back-compat.
 *
 * Exit codes:
 *   0  — selection recorded successfully (held → ready)
 *   1  — any refusal (validation error, no matching held card)
 */

import type { CliDeps } from './main';
import { applyHitlReply } from '../channels/slack';
import { DEFAULT_RUN_ID } from '../persistence/db';

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface ReplyFlags {
  correlationId: string | undefined;
  selection: string | undefined;
  runId: string;
}

function parseFlags(argv: string[]): ReplyFlags {
  let correlationId: string | undefined;
  let selection: string | undefined;
  let runId: string = DEFAULT_RUN_ID;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--correlation-id' && i + 1 < argv.length) {
      correlationId = argv[++i];
    } else if (arg === '--selection' && i + 1 < argv.length) {
      selection = argv[++i];
    } else if (arg === '--run' && i + 1 < argv.length) {
      runId = argv[++i]!;
    }
  }

  return { correlationId, selection, runId };
}

// ---------------------------------------------------------------------------
// Correlation id validation
//
// Mirrors the private extractCardId shape in src/channels/slack.ts:
//   format: hitl::<cardId>::<nonce>  (≥ 3 segments, first segment === 'hitl')
// ---------------------------------------------------------------------------

function isParseableCorrelationId(id: string): boolean {
  const parts = id.split('::');
  return parts.length >= 3 && parts[0] === 'hitl';
}

// ---------------------------------------------------------------------------
// cmdReply
// ---------------------------------------------------------------------------

/**
 * Handle `conduit reply --correlation-id <id> --selection <choice>`.
 *
 * Validates both flags before any side effect. On success, persists the
 * selection via applyHitlReply (transitions the held card held → ready and
 * journals the selection so a subsequent resume can act on it).
 *
 * @param argv  Command-line arguments starting with 'reply' (argv[0] === 'reply').
 * @param deps  Injected CLI seams (io, db, adapter, engine, prereqs).
 * @returns     0 on success, 1 on any refusal.
 */
export async function cmdReply(argv: string[], deps: CliDeps): Promise<number> {
  const { correlationId, selection, runId } = parseFlags(argv);

  // Validate selection first — no side effect must occur on any refusal (AC4).
  if (selection === undefined || selection === '') {
    deps.io.err('error: --selection is required and must be a non-empty string');
    return 1;
  }

  // Validate correlation id is present.
  if (correlationId === undefined) {
    deps.io.err('error: --correlation-id is required');
    return 1;
  }

  // Validate correlation id is parseable — produces a distinct error from the
  // no-match case so the caller can tell "bad id format" from "id not found" (AC3).
  if (!isParseableCorrelationId(correlationId)) {
    deps.io.err(
      `error: invalid correlation id '${correlationId}' — expected format: hitl::<cardId>::<nonce>`,
    );
    return 1;
  }

  // Persist the selection via the existing applyHitlReply (AC1, AC5).
  // applyHitlReply returns { resumed: false } for BOTH unknown and not-held cards;
  // parseability is checked above so the two failure modes emit distinct messages.
  const result = applyHitlReply(deps.db, correlationId, selection, runId);

  if (!result.resumed) {
    deps.io.err(`error: no matching held card for correlation id '${correlationId}'`);
    return 1;
  }

  return 0;
}
