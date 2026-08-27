import { createHash } from 'node:crypto';
import { validateRunId } from './run-id';
import type { ConduitDB, RunRecord } from '../persistence/db';

export type RegisterRunResult =
  | { kind: 'created'; run: RunRecord }
  | { kind: 'existing'; run: RunRecord }
  | { kind: 'conflict'; recorded: RunRecord };

export function registerRun(
  db: ConduitDB,
  runId: string,
  flow: string,
  inputFingerprint: string,
  projectRoot?: string,
): RegisterRunResult {
  validateRunId(runId);

  const recorded = db.getRun(runId);
  const normalizedProjectRoot = projectRoot ?? null;
  if (recorded === null) {
    db.insertRun({
      run_id: runId,
      flow,
      project_root: normalizedProjectRoot,
      input_fingerprint: inputFingerprint,
      status: 'running',
    });
    return { kind: 'created', run: db.getRun(runId)! };
  }

  if (
    recorded.flow === flow &&
    recorded.input_fingerprint === inputFingerprint &&
    (recorded.project_root ?? null) === normalizedProjectRoot
  ) {
    return { kind: 'existing', run: recorded };
  }

  return { kind: 'conflict', recorded };
}

function canonicalSort(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    sorted[key] =
      val !== null && typeof val === 'object' && !Array.isArray(val)
        ? canonicalSort(val as Record<string, unknown>)
        : val;
  }
  return sorted;
}

export function computeFingerprint(
  flow: string,
  inputs: Record<string, unknown>,
  projectRoot?: string,
): string {
  const payload = JSON.stringify({
    flow,
    input: canonicalSort(inputs),
    ...(projectRoot !== undefined ? { project_root: projectRoot } : {}),
  });
  return createHash('sha256').update(payload).digest('hex');
}
