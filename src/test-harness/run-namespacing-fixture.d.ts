/**
 * Type declarations for the WI-484 fixture harness (implementation in run-namespacing-fixture.ts, written by B.A.).
 */
import type { FlowConfig, Card } from '../types/kernel';
import type { ConduitDB } from '../persistence/db';

export declare const DEFAULT_RUN_ID: string;

export declare function writeFixtureFlow(dir: string): string;
export declare function loadFixtureFlow(flowPath: string): FlowConfig;
export declare function openTestDb(): ConduitDB;

export declare function seedRun(db: ConduitDB, runId: string): void;
export declare function seedCard(
  db: ConduitDB,
  runId: string,
  over: Partial<Card> & { id: string; lane: string },
): void;
export declare function seedCheckpoint(
  db: ConduitDB,
  runId: string,
  cardId: string,
  station: string,
  payloadValue: string,
): void;
export declare function seedPendingIntent(
  db: ConduitDB,
  runId: string,
  cardId: string,
  station: string,
  key: string,
): void;
export declare function driveRun(
  db: ConduitDB,
  flow: FlowConfig,
  runId: string,
  io?: IOCapture,
): Promise<void>;

export declare function getRunCards(db: ConduitDB, runId: string): Map<string, Card>;
export declare function laneCount(db: ConduitDB, runId: string): Record<string, number>;
export declare function outboxStatus(
  db: ConduitDB,
  runId: string,
  idempotencyKey: string,
): 'pending' | 'committed' | 'none';
export declare function snapshotCards(db: ConduitDB, runId: string): CardSnapshot;
export declare function cappedClock(maxTicks?: number, value?: number): () => number;

export declare const stubAdapter: import('../worker/adapter').ModelAdapter;

export interface IOCapture {
  io: { out(l: string): void; err(l: string): void };
  lines: string[];
}
export declare function makeIO(): IOCapture;

export type CardSnapshot = Map<string, { lane: string; status: string }>;
