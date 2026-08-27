import { resolve } from 'node:path';
import { D2 } from '@terrastruct/d2';
import pc from 'picocolors';
import { table } from 'table';
import { loadFlow } from '../src/flow/load';
import type { FanInPolicyConfig, FlowConfig, StationConfig } from '../src/types/kernel';

const DEFAULT_TERMINALS = ['done', 'scrap', 'hold'];

interface StationSummary {
  id: string;
  kind: string;
  worker: string;
  route: string;
  notes: string;
}

interface BackflowSummary {
  from: string;
  to: string;
  reason: string;
  scope: string;
}

interface CliOptions {
  flowPath: string;
  explicitFanoutLimit: number;
  asciiMode: 'extended' | 'standard';
  showSource: boolean;
  asciiPreview: boolean;
}

function parseArgs(argv: string[]): CliOptions | null {
  let flowPath: string | undefined;
  let explicitFanoutLimit = 4;
  let asciiMode: 'extended' | 'standard' = 'extended';
  let showSource = false;
  let asciiPreview = false;

  for (const arg of argv) {
    if (arg === '--compact') {
      explicitFanoutLimit = 0;
    } else if (arg.startsWith('--explicit-limit=')) {
      const value = Number(arg.slice('--explicit-limit='.length));
      if (Number.isInteger(value) && value >= 0) explicitFanoutLimit = value;
    } else if (arg === '--standard') {
      asciiMode = 'standard';
    } else if (arg === '--source') {
      showSource = true;
    } else if (arg === '--ascii-preview') {
      asciiPreview = true;
    } else if (!arg.startsWith('--') && flowPath === undefined) {
      flowPath = arg;
    }
  }

  if (flowPath === undefined) return null;
  return { flowPath, explicitFanoutLimit, asciiMode, showSource, asciiPreview };
}

function q(value: string): string {
  return JSON.stringify(value);
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'flow';
}

function d2Id(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function stationNodeId(id: string): string {
  return `s_${d2Id(id)}`;
}

function terminalNodeId(id: string): string {
  return `t_${d2Id(id)}`;
}

function copyNodeId(id: string, copy: number): string {
  return `c_${copy}_${d2Id(id)}`;
}

function terminalLanes(flow: FlowConfig): string[] {
  return flow.terminal_lanes ?? DEFAULT_TERMINALS;
}

function isTerminalLane(flow: FlowConfig, lane: string | null | undefined): boolean {
  return lane !== null && lane !== undefined && terminalLanes(flow).includes(lane);
}

function fallbackSuccessor(flow: FlowConfig, id: string): string | null {
  if (flow.happyPathNext !== undefined) return null;
  const ids = Object.keys(flow.stations);
  const index = ids.indexOf(id);
  if (index < 0) return null;
  return index + 1 < ids.length ? ids[index + 1]! : 'done';
}

function successorOf(flow: FlowConfig, id: string): string | null {
  return flow.happyPathNext?.[id] ?? flow.stations[id]?.next ?? fallbackSuccessor(flow, id);
}

function graphNodeRef(flow: FlowConfig, lane: string): string {
  return isTerminalLane(flow, lane) ? terminalNodeId(lane) : stationNodeId(lane);
}

function describeFanIn(policy: number | FanInPolicyConfig, fanOut?: number): string {
  if (typeof policy === 'number') {
    return fanOut !== undefined ? `${policy}/${fanOut}` : `survivors >= ${policy}`;
  }

  switch (policy.policy) {
    case 'quorum':
      return fanOut !== undefined ? `${policy.k}/${fanOut}` : `quorum ${policy.k}`;
    case 'all':
      return fanOut !== undefined ? `all ${fanOut}` : 'all';
    case 'best_effort':
      return 'best effort';
  }
}

function stationKind(station: StationConfig): string {
  if (station.rankCheck) return 'rank';
  if (station.gateCheck) return `${station.kind}+gate`;
  return station.kind;
}

function workerLabel(station: StationConfig): string {
  if (station.rankCheck) {
    return `${station.rankCheck.criticModel}`;
  }

  const role = station.role;
  const worker =
    station.kind === 'deterministic'
      ? station.command
      : station.model;

  if (role !== undefined && worker !== undefined) return `${role} / ${worker}`;
  if (role !== undefined) return role;
  if (worker !== undefined) return worker;
  return 'none';
}

function stationLabel(flow: FlowConfig, id: string, fanOutForJoin?: number): string {
  const station = flow.stations[id];
  const name = humanizeLane(id);
  if (station === undefined) return name;
  if (station.fan_out !== undefined) return `${name} [split x${station.fan_out}]`;
  if (station.fan_in !== undefined) {
    return `${name} [join ${describeFanIn(station.fan_in, fanOutForJoin)}]`;
  }
  if (station.rankCheck) return `${name} [rank]`;
  if (station.gateCheck) return `${name} [gate]`;
  return name;
}

function graphLaneLabel(flow: FlowConfig, lane: string, fanOutForJoin?: number): string {
  return isTerminalLane(flow, lane) ? humanizeLane(lane) : stationLabel(flow, lane, fanOutForJoin);
}

function defineNode(
  lines: string[],
  defined: Set<string>,
  id: string,
  label: string,
): void {
  if (defined.has(id)) return;
  defined.add(id);
  lines.push(`${id}: ${q(label)}`);
}

function defineGraphNode(
  flow: FlowConfig,
  lines: string[],
  defined: Set<string>,
  lane: string,
  fanOutForJoin?: number,
): void {
  if (isTerminalLane(flow, lane)) {
    defineNode(lines, defined, terminalNodeId(lane), graphLaneLabel(flow, lane, fanOutForJoin));
    return;
  }
  defineNode(lines, defined, stationNodeId(lane), graphLaneLabel(flow, lane, fanOutForJoin));
}

function addEdge(lines: string[], edges: Set<string>, from: string, to: string, label?: string): void {
  const line = `${from} -> ${to}${label !== undefined ? `: ${q(label)}` : ''}`;
  if (edges.has(line)) return;
  edges.add(line);
  lines.push(line);
}

function backEdgeReason(flow: FlowConfig, from: string): string {
  const gate = flow.stations[from]?.gateCheck;
  const label = gate?.criticRole ?? gate?.criticModel;
  return label !== undefined && label.length > 0 ? label : 'reject';
}

function backEdgeLabel(flow: FlowConfig, from: string): string {
  const reason = backEdgeReason(flow, from);
  return reason === 'reject' ? reason : `reject: ${reason}`;
}

function backflowNoteLabel(flow: FlowConfig, title: string, backEdges: ReadonlyArray<{ from: string; to: string }>): string {
  return [
    title,
    ...backEdges.map((edge) => `${edge.from} -> ${edge.to}: ${backEdgeReason(flow, edge.from)}`),
  ].join('\n');
}

function reworkNodeId(id: string, copy?: number): string {
  return copy === undefined ? `rework_${d2Id(id)}` : `rework_${copy}_${d2Id(id)}`;
}

interface FanOutTopology {
  id: string;
  station: StationConfig;
  fanOut: number;
  childEntry: string;
  childTerminal?: string;
  joinAt: string | null;
  childStations: string[];
  inferred: boolean;
}

function firstDownstreamFanIn(flow: FlowConfig, start: string): string | null {
  const seen = new Set<string>();
  let current: string | null = start;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const station = flow.stations[current];
    if (station === undefined || isTerminalLane(flow, current)) return null;
    if (station.fan_in !== undefined) return current;
    current = successorOf(flow, current);
  }

  return null;
}

function collectChildStations(
  flow: FlowConfig,
  entry: string,
  childTerminal: string | undefined,
  stopBefore?: string | null,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current: string | null = entry;

  while (
    current !== null &&
    current !== stopBefore &&
    flow.stations[current] !== undefined &&
    !isTerminalLane(flow, current) &&
    !seen.has(current)
  ) {
    seen.add(current);
    ids.push(current);

    const next = successorOf(flow, current);
    if (next === null || next === childTerminal || next === stopBefore || isTerminalLane(flow, next)) break;
    current = next;
  }

  return ids;
}

function inferFanOutTopology(flow: FlowConfig, id: string, station: StationConfig): FanOutTopology | null {
  if (station.fan_out === undefined) return null;

  const inferred = station.child_entry === undefined || station.resume_at === undefined;
  const fallbackChildEntry = successorOf(flow, id);
  const childEntry = station.child_entry ?? (fallbackChildEntry !== null && flow.stations[fallbackChildEntry] !== undefined
    ? fallbackChildEntry
    : undefined);
  if (childEntry === undefined) return null;

  const joinAt =
    station.resume_at ??
    (station.next !== undefined && station.next !== childEntry ? station.next : undefined) ??
    firstDownstreamFanIn(flow, childEntry);
  const childStations = collectChildStations(flow, childEntry, station.child_terminal, joinAt);

  return {
    id,
    station,
    fanOut: station.fan_out,
    childEntry,
    ...(station.child_terminal !== undefined ? { childTerminal: station.child_terminal } : {}),
    joinAt,
    childStations,
    inferred,
  };
}

function collectLaneChain(
  flow: FlowConfig,
  start: string,
  blockedStations: Set<string>,
): string[] {
  const lanes: string[] = [];
  const seen = new Set<string>();
  let current: string | null = start;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    lanes.push(current);

    if (isTerminalLane(flow, current)) break;
    if (blockedStations.has(current) && current !== start) break;

    const next = successorOf(flow, current);
    if (next === null) break;
    current = next;
  }

  return lanes;
}

function routeSummary(flow: FlowConfig, id: string): string {
  const station = flow.stations[id]!;
  if (station.fan_out !== undefined) {
    const topology = inferFanOutTopology(flow, id, station);
    const join = topology?.joinAt ?? 'unknown';
    return `split x${station.fan_out} -> ${topology?.childEntry ?? '?'}; join ${join}`;
  }

  const next = successorOf(flow, id);
  return next === null ? 'no next' : `-> ${next}`;
}

function noteSummary(flow: FlowConfig, id: string): string {
  const station = flow.stations[id]!;
  const notes: string[] = [];

  if (station.fan_in !== undefined) notes.push(`fan-in ${describeFanIn(station.fan_in)}`);
  if (station.gateCheck) notes.push(`reject -> ${station.gateCheck.onReject}`);
  if (station.rankCheck) notes.push(station.rankCheck.hitlEnabled ? 'HITL rank' : 'rank no-HITL');
  if (station.effectful) notes.push('effectful');
  if (station.child_terminal !== undefined) notes.push(`child terminal ${station.child_terminal}`);
  if (station.fan_out !== undefined && station.child_entry === undefined) notes.push('legacy topology inferred');

  return notes.join(', ') || '-';
}

function buildStationSummaries(flow: FlowConfig): StationSummary[] {
  return Object.entries(flow.stations).map(([id, station]) => ({
    id,
    kind: stationKind(station),
    worker: workerLabel(station),
    route: routeSummary(flow, id),
    notes: noteSummary(flow, id),
  }));
}

function buildBackflowSummaries(flow: FlowConfig): BackflowSummary[] {
  const fanOutEntries = Object.entries(flow.stations)
    .map(([id, station]) => inferFanOutTopology(flow, id, station))
    .filter((topology): topology is FanOutTopology => topology !== null);

  return (flow.back_edges ?? []).map((edge) => {
    const topology = fanOutEntries.find((entry) =>
      entry.childStations.includes(edge.from) &&
      (entry.childStations.includes(edge.to) || edge.to === entry.childTerminal),
    );
    return {
      from: edge.from,
      to: edge.to,
      reason: backEdgeReason(flow, edge.from),
      scope: topology === undefined ? 'mission' : `${topology.id} child lane`,
    };
  });
}

function renderStationTable(flow: FlowConfig): string {
  const rows = [
    [
      pc.bold('station'),
      pc.bold('kind'),
      pc.bold('worker'),
      pc.bold('route'),
      pc.bold('notes'),
    ],
    ...buildStationSummaries(flow).map((station) => [
      pc.cyan(station.id),
      station.kind === 'rank' ? pc.magenta(station.kind) : pc.yellow(station.kind),
      station.worker,
      station.route,
      station.notes,
    ]),
  ];

  return table(rows, {
    columns: {
      0: { width: 16, wrapWord: true },
      1: { width: 15, wrapWord: true },
      2: { width: 26, wrapWord: true },
      3: { width: 30, wrapWord: true },
      4: { width: 34, wrapWord: true },
    },
  });
}

function renderBackflowTable(flow: FlowConfig): string | null {
  const summaries = buildBackflowSummaries(flow);
  if (summaries.length === 0) return null;

  const rows = [
    [
      pc.bold('from'),
      pc.bold('to'),
      pc.bold('reason'),
      pc.bold('scope'),
    ],
    ...summaries.map((edge) => [
      pc.cyan(edge.from),
      pc.cyan(edge.to),
      edge.reason,
      edge.scope,
    ]),
  ];

  return table(rows, {
    columns: {
      0: { width: 14, wrapWord: true },
      1: { width: 14, wrapWord: true },
      2: { width: 24, wrapWord: true },
      3: { width: 22, wrapWord: true },
    },
  });
}

function collectUntil(flow: FlowConfig, start: string, stopAt: string): string[] {
  const lanes: string[] = [];
  const seen = new Set<string>();
  let current: string | null = start;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    lanes.push(current);
    if (current === stopAt) break;
    current = successorOf(flow, current);
  }

  return lanes;
}

function humanizeLane(lane: string): string {
  return lane.replace(/[_-]+/g, ' ');
}

function laneLabel(flow: FlowConfig, lane: string, fanOutByJoin = new Map<string, number>()): string {
  if (isTerminalLane(flow, lane)) return pc.green(humanizeLane(lane));
  const station = flow.stations[lane];
  const label = stationLabel(flow, lane, fanOutByJoin.get(lane));
  if (station?.fan_out !== undefined) return pc.magenta(label);
  if (station?.fan_in !== undefined) return pc.magenta(label);
  if (station?.rankCheck !== undefined) return pc.magenta(label);
  if (station?.gateCheck !== undefined) return pc.yellow(label);
  return pc.cyan(label);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function visibleLength(value: string): number {
  return Array.from(stripAnsi(value)).length;
}

function padVisible(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleLength(value)))}`;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function reworkTargets(
  flow: FlowConfig,
  lane: string,
  backEdgeScope?: ReadonlySet<string>,
): string[] {
  return (flow.back_edges ?? [])
    .filter((edge) => edge.from === lane)
    .filter((edge) => backEdgeScope === undefined || backEdgeScope.has(edge.to))
    .map((edge) => edge.to);
}

function boxSubtitle(flow: FlowConfig, lane: string): string {
  if (isTerminalLane(flow, lane)) return '';
  return flow.stations[lane]?.role ?? '';
}

function nodeBox(label: string, subtitle: string | undefined, targets: string[]): string[] {
  const reworkTargets = Array.from(new Set(targets)).map(humanizeLane);
  const rework = reworkTargets.length > 0 ? pc.red(`↺ ${reworkTargets.join(', ')}`) : '';
  const caption = subtitle !== undefined && subtitle.length > 0 ? pc.dim(subtitle) : '';
  const bodyRows = subtitle === undefined ? [label, rework] : [label, caption, rework];
  const innerWidth = Math.max(...bodyRows.map(visibleLength), 6);
  return [
    `┌${'─'.repeat(innerWidth + 2)}┐`,
    ...bodyRows.map((row) => `│ ${padVisible(row, innerWidth)} │`),
    `└${'─'.repeat(innerWidth + 2)}┘`,
  ];
}

function joinBoxes(boxes: string[][]): string[] {
  const height = Math.max(0, ...boxes.map((box) => box.length));
  const lines = Array.from({ length: height }, () => '');
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;
    const hasNext = i < boxes.length - 1;
    for (let row = 0; row < lines.length; row++) {
      const connector = hasNext ? (row === 1 ? pc.dim('──▶') : '   ') : '';
      lines[row] += `${box[row] ?? ''}${connector}`;
    }
  }
  return lines;
}

function renderBoxedChain(
  flow: FlowConfig,
  lanes: string[],
  opts: {
    fanOutByJoin?: Map<string, number>;
    backEdgeScope?: ReadonlySet<string>;
    perLine?: number;
    showSubtitle?: boolean;
  } = {},
): string[] {
  const lines: string[] = [];
  const rows = chunk(lanes, opts.perLine ?? 3);

  rows.forEach((row, index) => {
    const boxes = row.map((lane) => nodeBox(
      laneLabel(flow, lane, opts.fanOutByJoin),
      opts.showSubtitle === true ? boxSubtitle(flow, lane) : undefined,
      reworkTargets(flow, lane, opts.backEdgeScope),
    ));
    lines.push(...joinBoxes(boxes));
    if (index < rows.length - 1) {
      lines.push(pc.dim('  │'));
      lines.push(pc.dim('  ▼'));
    }
  });

  return lines;
}

function laneCenterColumn(
  flow: FlowConfig,
  lanes: string[],
  targetLane: string,
  opts: {
    fanOutByJoin?: Map<string, number>;
    backEdgeScope?: ReadonlySet<string>;
    perLine?: number;
    showSubtitle?: boolean;
  } = {},
): number {
  const perLine = opts.perLine ?? 3;
  const targetIndex = lanes.lastIndexOf(targetLane);
  if (targetIndex < 0) return 0;

  const rowStart = Math.floor(targetIndex / perLine) * perLine;
  const row = lanes.slice(rowStart, rowStart + perLine);
  let column = 0;

  for (let index = 0; index < row.length; index++) {
    const lane = row[index]!;
    const box = nodeBox(
      laneLabel(flow, lane, opts.fanOutByJoin),
      opts.showSubtitle === true ? boxSubtitle(flow, lane) : undefined,
      reworkTargets(flow, lane, opts.backEdgeScope),
    );
    const width = visibleLength(box[0] ?? '');

    if (lane === targetLane) return column + Math.floor(width / 2);
    column += width + 3;
  }

  return 0;
}

function renderFramedBlock(
  title: string,
  bodyLines: string[],
  firstPrefix: string,
  bodyPrefix: string,
): string[] {
  const titleText = ` ${title} `;
  const maxBodyWidth = Math.max(0, ...bodyLines.map(visibleLength));
  const innerWidth = Math.max(maxBodyWidth, visibleLength(titleText) + 2);
  const topTitle = `─${titleText}`;
  const topInside = `${topTitle}${'─'.repeat(Math.max(0, innerWidth + 2 - visibleLength(topTitle)))}`;

  return [
    `${firstPrefix}╭${topInside}╮`,
    ...bodyLines.map((line) => `${bodyPrefix}│ ${padVisible(line, innerWidth)} │`),
    `${bodyPrefix}╰${'─'.repeat(innerWidth + 2)}╯`,
  ];
}

function renderFlowOverview(flow: FlowConfig): string {
  const ids = Object.keys(flow.stations);
  const firstStation = ids[0];
  if (firstStation === undefined) return '';

  const fanOutEntries = Object.entries(flow.stations)
    .map(([id, station]) => inferFanOutTopology(flow, id, station))
    .filter((topology): topology is FanOutTopology => topology !== null);

  const childIds = new Set<string>();
  const fanOutByJoin = new Map<string, number>();
  for (const topology of fanOutEntries) {
    for (const childId of topology.childStations) childIds.add(childId);
    if (topology.joinAt !== null) fanOutByJoin.set(topology.joinAt, topology.fanOut);
  }

  const lines: string[] = [];

  if (fanOutEntries.length === 0) {
    lines.push(...renderBoxedChain(flow, collectLaneChain(flow, firstStation, new Set())));
  } else {
    for (const topology of fanOutEntries) {
      const prefix = collectUntil(flow, firstStation, topology.id);
      if (prefix.length > 0) {
        lines.push(...renderBoxedChain(flow, prefix));
      }
      const branchColumn = laneCenterColumn(flow, prefix, topology.id);
      const branchIndent = ' '.repeat(branchColumn);
      lines.push(pc.dim(`${branchIndent}│`));

      const childLane = topology.childTerminal !== undefined
        ? [...topology.childStations, topology.childTerminal]
        : topology.childStations;
      const childBackEdgeScope = new Set(childLane);

      lines.push(...renderFramedBlock(
        pc.magenta(`child lane x${topology.fanOut} / spawn x${topology.fanOut}`),
        renderBoxedChain(flow, childLane, { backEdgeScope: childBackEdgeScope, showSubtitle: true }),
        `${branchIndent}├─`,
        `${branchIndent}│ `,
      ));

      if (topology.joinAt !== null) {
        const afterJoin = collectLaneChain(flow, topology.joinAt, childIds);
        lines.push(...renderFramedBlock(
          pc.magenta('join survivors'),
          renderBoxedChain(flow, afterJoin, { fanOutByJoin }),
          `${branchIndent}└─`,
          `${branchIndent}  `,
        ));
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildD2Source(flow: FlowConfig, opts: { explicitFanoutLimit: number }): string {
  const lines: string[] = ['direction: right'];
  const defined = new Set<string>();
  const edges = new Set<string>();

  const fanOutEntries = Object.entries(flow.stations)
    .map(([id, station]) => inferFanOutTopology(flow, id, station))
    .filter((topology): topology is FanOutTopology => topology !== null);

  const childIds = new Set<string>();
  const fanOutByJoin = new Map<string, number>();
  for (const topology of fanOutEntries) {
    for (const childId of topology.childStations) childIds.add(childId);
    if (topology.joinAt !== null) fanOutByJoin.set(topology.joinAt, topology.fanOut);
  }

  for (const topology of fanOutEntries) {
    const { id, fanOut, childEntry, childTerminal, joinAt, childStations } = topology;
    const childLane = childTerminal !== undefined ? [...childStations, childTerminal] : childStations;
    const childExit = childLane[childLane.length - 1];
    if (childExit === undefined) continue;
    const childBackEdges = (flow.back_edges ?? []).filter((edge) =>
      childStations.includes(edge.from) && childLane.includes(edge.to),
    );

    defineGraphNode(flow, lines, defined, id);

    if (fanOut <= opts.explicitFanoutLimit) {
      for (let copy = 1; copy <= fanOut; copy++) {
        const laneId = `child_${d2Id(id)}_${copy}`;
        lines.push(`${laneId}: {`);
        lines.push(`  label: ${q(`child ${copy}`)}`);
        for (const lane of childLane) {
          lines.push(`  ${copyNodeId(lane, copy)}: ${q(graphLaneLabel(flow, lane))}`);
        }
        lines.push(`  ${childLane.map((lane) => copyNodeId(lane, copy)).join(' -> ')}`);
        if (childBackEdges.length > 0) {
          lines.push(`  ${reworkNodeId(id, copy)}: ${q(backflowNoteLabel(flow, 'rework routes', childBackEdges))}`);
        }
        lines.push('}');
        addEdge(lines, edges, stationNodeId(id), `${laneId}.${copyNodeId(childEntry, copy)}`, `spawn ${copy}`);
        if (joinAt !== null) {
          defineGraphNode(flow, lines, defined, joinAt, fanOut);
          addEdge(
            lines,
            edges,
            `${laneId}.${copyNodeId(childExit, copy)}`,
            graphNodeRef(flow, joinAt),
            'survives',
          );
        }
      }
    } else {
      const laneId = `child_lane_${d2Id(id)}`;
      lines.push(`${laneId}: {`);
      lines.push(`  label: ${q(`child lane x${fanOut}`)}`);
      for (const lane of childLane) {
        lines.push(`  ${graphNodeRef(flow, lane)}: ${q(graphLaneLabel(flow, lane))}`);
      }
      lines.push(`  ${childLane.map((lane) => graphNodeRef(flow, lane)).join(' -> ')}`);
      if (childBackEdges.length > 0) {
        lines.push(`  ${reworkNodeId(id)}: ${q(backflowNoteLabel(flow, 'rework routes', childBackEdges))}`);
      }
      lines.push('}');
      addEdge(lines, edges, stationNodeId(id), `${laneId}.${graphNodeRef(flow, childEntry)}`, `spawn x${fanOut}`);
      if (joinAt !== null) {
        defineGraphNode(flow, lines, defined, joinAt, fanOut);
        addEdge(
          lines,
          edges,
          `${laneId}.${graphNodeRef(flow, childExit)}`,
          graphNodeRef(flow, joinAt),
          'join survivors',
        );
      }
    }

    if (joinAt !== null) {
      const afterJoin = collectLaneChain(flow, joinAt, childIds);
      for (const lane of afterJoin) defineGraphNode(flow, lines, defined, lane, fanOutByJoin.get(lane));
      for (let i = 0; i < afterJoin.length - 1; i++) {
        addEdge(lines, edges, graphNodeRef(flow, afterJoin[i]!), graphNodeRef(flow, afterJoin[i + 1]!));
      }
    }
  }

  // Add ordinary happy-path edges outside child lanes. Fan-out parents are
  // rendered through split/child/join edges above, so their direct `next` edge is
  // intentionally suppressed.
  for (const [id, station] of Object.entries(flow.stations)) {
    if (childIds.has(id)) continue;
    defineGraphNode(flow, lines, defined, id, fanOutByJoin.get(id));
    if (station.fan_out !== undefined) continue;

    const next = successorOf(flow, id);
    if (next === null || childIds.has(next)) continue;
    defineGraphNode(flow, lines, defined, next, fanOutByJoin.get(next));
    addEdge(lines, edges, graphNodeRef(flow, id), graphNodeRef(flow, next));
  }

  const summarizedBackEdges: Array<{ from: string; to: string }> = [];
  for (const edge of flow.back_edges ?? []) {
    if (childIds.has(edge.from)) continue;
    defineGraphNode(flow, lines, defined, edge.from);
    defineGraphNode(flow, lines, defined, edge.to);
    if (edge.from === edge.to) {
      addEdge(lines, edges, graphNodeRef(flow, edge.from), graphNodeRef(flow, edge.to), backEdgeLabel(flow, edge.from));
    } else {
      summarizedBackEdges.push(edge);
    }
  }

  if (summarizedBackEdges.length > 0) {
    defineNode(lines, defined, 'mission_backflow', backflowNoteLabel(flow, 'mission backflow', summarizedBackEdges));
  }

  return `${lines.join('\n')}\n`;
}

async function renderD2(source: string, asciiMode: 'extended' | 'standard'): Promise<string> {
  const d2 = new D2();
  const compiled = await d2.compile(source, {
    layout: 'elk',
    ascii: true,
    asciiMode,
    pad: 20,
  });
  return d2.render(compiled.diagram, compiled.renderOptions);
}

async function renderSvg(source: string): Promise<string> {
  const d2 = new D2();
  const compiled = await d2.compile(source, {
    layout: 'elk',
    pad: 40,
    scale: 1,
  });
  return d2.render(compiled.diagram, compiled.renderOptions);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    console.error('usage: bun scripts/explain-d2-spike.ts <flow.yaml> [--compact] [--standard] [--ascii-preview] [--source]');
    process.exit(1);
  }

  const loaded = loadFlow(resolve(opts.flowPath));
  if (!loaded.ok) {
    for (const err of loaded.errors) {
      console.error(pc.red(`validation error [${err.code}]: ${err.message}`));
    }
    process.exit(1);
  }

  const flow = loaded.flow;
  const source = buildD2Source(flow, { explicitFanoutLimit: opts.explicitFanoutLimit });
  const flowSlug = slug(flow.name ?? 'unnamed');
  const d2Path = `/tmp/conduit-explain-d2-spike-${flowSlug}.d2`;
  const svgPath = `/tmp/conduit-explain-d2-spike-${flowSlug}.svg`;
  await Bun.write(d2Path, source);

  console.log(pc.bold(`Flow: ${flow.name ?? '(unnamed)'}`));
  console.log(pc.dim(opts.explicitFanoutLimit === 0 ? 'D2 SVG generated with collapsed fan-out' : 'D2 SVG generated'));
  console.log();
  console.log(pc.bold('Flow'));
  console.log(renderFlowOverview(flow));

  if (opts.asciiPreview) {
    console.log(pc.bold('D2 ASCII Preview'));
    console.log(await renderD2(source, opts.asciiMode));
  }

  console.log(pc.bold('Stations'));
  console.log(renderStationTable(flow));

  const backflowTable = renderBackflowTable(flow);
  if (backflowTable !== null) {
    console.log(pc.bold('Backflow'));
    console.log(backflowTable);
  }

  if (opts.showSource) {
    console.log(pc.bold('Generated D2'));
    console.log(source);
  }

  const svg = await renderSvg(source);
  await Bun.write(svgPath, svg);
  console.log(pc.dim(`wrote ${d2Path}`));
  console.log(pc.dim(`wrote ${svgPath}`));
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  },
);
