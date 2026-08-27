// WAR ROOM — mock event journal + projection logic.
// The whole UI is a read-only projection of this journal.

export type Status =
  | "waiting"
  | "ready"
  | "claimed"
  | "working"
  | "done_pending_ack"
  | "held"
  | "interrupted"
  | "awaiting_children"
  | "complete"
  | "scrapped"

export type Station =
  | "brief"
  | "draft"
  | "publish"
  | "assemble"
  | "rank"
  | "deliver"

export type EventName =
  | "CLAIM"
  | "START_WORK"
  | "MARK_DONE"
  | "INTEGRITY_PASS"
  | "INTEGRITY_FAIL"
  | "QC_REJECT"
  | "FAN_OUT"
  | "FAN_IN_MET"
  | "NEEDS_JUDGMENT"

export type JournalEvent = {
  seq: number
  tSec: number
  cardId: string
  event: EventName
  fromLane: string
  toLane: string
  findings?: string[]
  costUsd?: number
  tokens?: number
}

export const STATIONS: Station[] = [
  "brief",
  "draft",
  "publish",
  "assemble",
  "rank",
  "deliver",
]

export const STATION_COLOR: Record<Station, string> = {
  brief: "#b388ff",
  draft: "#ff2d78",
  publish: "#ff9f1c",
  assemble: "#ffe600",
  rank: "#00e5ff",
  // teal so a working deliver segment's leading edge stays visible against the green now-line
  deliver: "#00d68f",
}

export const HELD_COLOR = "#ffb000"
export const SCRAP_COLOR = "#ff3b30"
export const COMPLETE_COLOR = "#39ff14"
export const IDLE_COLOR = "#555555"

export const RUN_START_LABEL = "branching"
// wall budget lives in the same units as the time axis (seconds) so it can be
// drawn as a vertical "wall" line that the run visibly approaches.
export const WALL_BUDGET_SEC = 75
export const TOK_BUDGET = 120_000
export const WATCHDOG_THRESHOLD_SEC = 40
export const HELD_DEADLINE_SEC = 70 // c-000 HITL pick deadline
export const NOW_SEC = 52 // run is currently at t52

// Card metadata (tree structure + costs).
export type CardMeta = {
  id: string
  parentId: string | null
  costUsd: number
}

export const CARDS: CardMeta[] = [
  { id: "c-000", parentId: null, costUsd: 0.04 },
  { id: "c-001", parentId: null, costUsd: 0.11 },
  { id: "c-002", parentId: "c-001", costUsd: 0.07 },
  { id: "c-003", parentId: "c-001", costUsd: 0.08 },
  { id: "c-004", parentId: "c-001", costUsd: 0.08 },
]

// The authored scenario, as a flat journal sorted by seq/time.
export const JOURNAL: JournalEvent[] = [
  // c-001 brief begins
  { seq: 1, tSec: 2, cardId: "c-001", event: "CLAIM", fromLane: "ready", toLane: "brief" },
  { seq: 2, tSec: 2, cardId: "c-001", event: "START_WORK", fromLane: "brief", toLane: "brief", tokens: 1200 },
  // c-000 rank
  { seq: 3, tSec: 0, cardId: "c-000", event: "CLAIM", fromLane: "ready", toLane: "rank" },
  { seq: 4, tSec: 0, cardId: "c-000", event: "START_WORK", fromLane: "rank", toLane: "rank", tokens: 2200 },
  { seq: 5, tSec: 8, cardId: "c-000", event: "NEEDS_JUDGMENT", fromLane: "rank", toLane: "held", costUsd: 0.04, tokens: 4100 },
  // c-001 brief done -> fan out
  { seq: 6, tSec: 12, cardId: "c-001", event: "MARK_DONE", fromLane: "brief", toLane: "brief", costUsd: 0.03, tokens: 5200 },
  { seq: 7, tSec: 12, cardId: "c-001", event: "FAN_OUT", fromLane: "brief", toLane: "awaiting_children", findings: ["spawned c-002", "spawned c-003", "spawned c-004"] },
  // children claim draft
  { seq: 8, tSec: 12, cardId: "c-002", event: "CLAIM", fromLane: "ready", toLane: "draft" },
  { seq: 9, tSec: 12, cardId: "c-003", event: "CLAIM", fromLane: "ready", toLane: "draft" },
  { seq: 10, tSec: 12, cardId: "c-004", event: "CLAIM", fromLane: "ready", toLane: "draft" },
  // c-004 reject loop
  { seq: 11, tSec: 20, cardId: "c-004", event: "QC_REJECT", fromLane: "draft", toLane: "draft", findings: ["hook is generic", "no colorway named"], costUsd: 0.03, tokens: 3000 },
  // c-002 draft done -> publish
  { seq: 12, tSec: 25, cardId: "c-002", event: "MARK_DONE", fromLane: "draft", toLane: "publish", costUsd: 0.03, tokens: 4200 },
  // c-004 rejected again -> scrap
  { seq: 13, tSec: 28, cardId: "c-004", event: "QC_REJECT", fromLane: "draft", toLane: "scrapped", findings: ["hook still generic", "rework cap reached"], costUsd: 0.05, tokens: 5200 },
  // c-003 draft done -> publish
  { seq: 14, tSec: 30, cardId: "c-003", event: "MARK_DONE", fromLane: "draft", toLane: "publish", costUsd: 0.04, tokens: 4800 },
  // c-002 publish done -> complete
  { seq: 15, tSec: 31, cardId: "c-002", event: "INTEGRITY_PASS", fromLane: "publish", toLane: "complete", costUsd: 0.04, tokens: 2100 },
  // c-003 publish done -> complete
  { seq: 16, tSec: 40, cardId: "c-003", event: "INTEGRITY_PASS", fromLane: "publish", toLane: "complete", costUsd: 0.04, tokens: 2300 },
  // c-001 fan in met
  { seq: 17, tSec: 40, cardId: "c-001", event: "FAN_IN_MET", fromLane: "awaiting_children", toLane: "assemble", findings: ["2 of 3 landed", "k=2 quorum"] },
  { seq: 18, tSec: 40, cardId: "c-001", event: "START_WORK", fromLane: "assemble", toLane: "assemble", tokens: 1500 },
  { seq: 19, tSec: 46, cardId: "c-001", event: "MARK_DONE", fromLane: "assemble", toLane: "rank", costUsd: 0.03, tokens: 3000 },
  { seq: 20, tSec: 46, cardId: "c-001", event: "START_WORK", fromLane: "rank", toLane: "rank" },
  { seq: 21, tSec: 50, cardId: "c-001", event: "MARK_DONE", fromLane: "rank", toLane: "deliver", costUsd: 0.02, tokens: 2600 },
  { seq: 22, tSec: 50, cardId: "c-001", event: "START_WORK", fromLane: "deliver", toLane: "deliver", tokens: 900 },
]

// ── Projection types ──────────────────────────────────────────────

export type Segment = {
  station: Station
  startSec: number
  endSec: number
  rework?: boolean // this segment is a bounce-back to an earlier station
}

export type RowState =
  | "working"
  | "held"
  | "scrapped"
  | "complete"
  | "awaiting_children"
  | "idle"

export type CardRow = {
  id: string
  parentId: string | null
  depth: number
  costUsd: number
  segments: Segment[]
  state: RowState
  status: Status // kernel status for the detail chip
  hasEvents: boolean // false => "— no events yet —" at this point in time
  // markers
  awaitingFrom?: number // dotted line from here
  awaitingTo?: number
  reworkCount?: number
  reworkCap?: number
  attempt?: number
  attemptCap?: number
  heldFrom?: number
  heldLabel?: string
  fanInLabel?: string
  fanOutAt?: number
  scrapLabel?: string
  endSec: number
  startSec: number
  events: JournalEvent[]
  ownedPaths?: string[]
  lastStation?: Station
}

// Build per-card projection from the journal up to a given seq cutoff.
export function projectRows(events: JournalEvent[], nowSec: number): CardRow[] {
  const byCard = new Map<string, JournalEvent[]>()
  for (const c of CARDS) byCard.set(c.id, [])
  for (const e of events) {
    if (!byCard.has(e.cardId)) byCard.set(e.cardId, [])
    byCard.get(e.cardId)!.push(e)
  }

  const rows: CardRow[] = []

  for (const meta of CARDS) {
    const evs = (byCard.get(meta.id) ?? []).slice().sort((a, b) => a.seq - b.seq)
    const depth = meta.parentId ? 1 : 0
    const row: CardRow = {
      id: meta.id,
      parentId: meta.parentId,
      depth,
      costUsd: 0,
      segments: [],
      state: "idle",
      status: "waiting",
      hasEvents: evs.length > 0,
      endSec: nowSec,
      startSec: nowSec,
      events: evs,
      ownedPaths: [],
    }

    let cost = 0
    let tokens = 0
    let curStation: Station | null = null
    let curStart = 0
    let firstT = evs.length ? evs[0].tSec : nowSec
    let reworkCount = 0

    const closeSeg = (endSec: number, rework: boolean) => {
      if (curStation) {
        row.segments.push({
          station: curStation,
          startSec: curStart,
          endSec,
          rework,
        })
      }
    }

    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]
      if (typeof e.costUsd === "number") cost += e.costUsd
      if (typeof e.tokens === "number") tokens += e.tokens

      switch (e.event) {
        case "CLAIM": {
          curStation = e.toLane as Station
          curStart = e.tSec
          row.status = "claimed"
          break
        }
        case "START_WORK": {
          if (!curStation) {
            curStation = e.toLane as Station
            curStart = e.tSec
          }
          row.state = "working"
          row.status = "working"
          break
        }
        case "MARK_DONE": {
          // close current station, advance to toLane if it's a station
          closeSeg(e.tSec, isReworkSeg(curStation, reworkCount, i, evs))
          const next = e.toLane
          if (STATIONS.includes(next as Station)) {
            curStation = next as Station
            curStart = e.tSec
            row.state = "working"
            row.status = "ready"
          } else {
            curStation = null
            row.status = "done_pending_ack"
          }
          break
        }
        case "QC_REJECT": {
          // close current, bounce back to toLane (earlier station) OR scrap
          if (e.toLane === "scrapped") {
            closeSeg(e.tSec, false)
            curStation = null
            row.state = "scrapped"
            row.status = "scrapped"
            row.scrapLabel = "rework_cap"
            // the bounce that triggered the scrap counts toward the rework tally
            reworkCount += 1
          } else {
            closeSeg(e.tSec, false)
            reworkCount += 1
            curStation = e.toLane as Station
            curStart = e.tSec
            row.state = "working"
            row.status = "working"
          }
          break
        }
        case "INTEGRITY_PASS": {
          closeSeg(e.tSec, false)
          curStation = null
          if (e.toLane === "complete") {
            row.state = "complete"
            row.status = "complete"
          }
          break
        }
        case "INTEGRITY_FAIL": {
          closeSeg(e.tSec, false)
          curStation = null
          break
        }
        case "NEEDS_JUDGMENT": {
          closeSeg(e.tSec, false)
          curStation = null
          row.state = "held"
          row.status = "held"
          row.heldFrom = e.tSec
          break
        }
        case "FAN_OUT": {
          closeSeg(e.tSec, false)
          curStation = null
          row.state = "awaiting_children"
          row.status = "awaiting_children"
          row.fanOutAt = e.tSec
          row.awaitingFrom = e.tSec
          break
        }
        case "FAN_IN_MET": {
          row.awaitingTo = e.tSec
          row.fanInLabel = "fan-in 2/3 · k=2 ✓"
          const next = e.toLane
          if (STATIONS.includes(next as Station)) {
            curStation = next as Station
            curStart = e.tSec
            row.state = "working"
            row.status = "working"
          }
          break
        }
      }
    }

    // close any open segment at now
    if (curStation) {
      closeSeg(nowSec, false)
    }

    // drop zero-width segments (e.g. MARK_DONE landing on the same lane)
    row.segments = row.segments.filter((s) => s.endSec > s.startSec)

    // mark rework segments by detecting decreasing station index after a QC_REJECT
    markRework(row)

    row.costUsd = cost
    row.startSec = firstT
    row.reworkCount = reworkCount
    row.reworkCap = 2
    row.attempt = reworkCount + 1
    row.attemptCap = 4
    row.lastStation = curStation ?? lastStationOf(row)

    // held label / countdown handled at render (live)
    if (row.state === "held") {
      row.heldLabel = "HITL pick"
    }

    // owned paths flavor
    row.ownedPaths = ownedPathsFor(meta.id)

    rows.push(row)
  }

  return rows
}

function isReworkSeg(
  _station: Station | null,
  _reworkCount: number,
  _i: number,
  _evs: JournalEvent[],
): boolean {
  return false
}

function markRework(row: CardRow) {
  // A segment is "rework" if its station index is <= a previously-seen max index.
  let maxIdx = -1
  for (const seg of row.segments) {
    const idx = STATIONS.indexOf(seg.station)
    if (idx <= maxIdx) {
      seg.rework = true
    }
    if (idx > maxIdx) maxIdx = idx
  }
}

function lastStationOf(row: CardRow): Station | undefined {
  if (!row.segments.length) return undefined
  return row.segments[row.segments.length - 1].station
}

function ownedPathsFor(id: string): string[] {
  const map: Record<string, string[]> = {
    "c-000": ["feeds/rank.json"],
    "c-001": ["briefs/launch.md", "out/assembly.json"],
    "c-002": ["drafts/c-002.md", "pub/c-002.html"],
    "c-003": ["drafts/c-003.md", "pub/c-003.html"],
    "c-004": ["drafts/c-004.md"],
  }
  return map[id] ?? []
}

// Held countdown: c-000's HITL deadline is HELD_DEADLINE_SEC. Once now passes it,
// the card is OVERDUE (no negative numbers) and the bar keeps growing.
export function heldSecondsLeft(nowSec: number): number {
  return Math.max(0, HELD_DEADLINE_SEC - nowSec)
}

export function isHeldOverdue(nowSec: number): boolean {
  return nowSec >= HELD_DEADLINE_SEC
}

// ── Header projection ─────────────────────────────────────────────
// Everything in the header is derived from the visible journal slice + nowSec,
// so it rolls back identically in replay. No element reads the live head.
export type HeaderStats = {
  wallSec: number
  tokUsed: number
  totalCost: number
  done: number
  scrap: number
  held: number
  lastProgressSec: number | null // null => no events yet
}

export function projectHeader(
  events: JournalEvent[],
  rows: CardRow[],
  nowSec: number,
): HeaderStats {
  const tokUsed = events.reduce((a, e) => a + (e.tokens ?? 0), 0)
  const totalCost = rows.reduce((a, r) => a + r.costUsd, 0)
  const lastT = events.length ? Math.max(...events.map((e) => e.tSec)) : null
  return {
    wallSec: nowSec,
    tokUsed,
    totalCost,
    done: rows.filter((r) => r.state === "complete").length,
    scrap: rows.filter((r) => r.state === "scrapped").length,
    held: rows.filter((r) => r.state === "held").length,
    lastProgressSec: lastT == null ? null : Math.max(0, nowSec - lastT),
  }
}

// ── Event display helpers ─────────────────────────────────────────

export const EVENT_LANE_FOR_COLOR: Record<string, string> = {
  ...STATION_COLOR,
  held: HELD_COLOR,
  scrapped: SCRAP_COLOR,
  complete: COMPLETE_COLOR,
}

export function eventColor(e: JournalEvent): string {
  switch (e.event) {
    case "QC_REJECT":
      return e.toLane === "scrapped" ? SCRAP_COLOR : STATION_COLOR.draft
    case "INTEGRITY_FAIL":
      return SCRAP_COLOR
    case "NEEDS_JUDGMENT":
      return HELD_COLOR
    case "INTEGRITY_PASS":
      return e.toLane === "complete" ? COMPLETE_COLOR : STATION_COLOR.rank
    case "FAN_OUT":
    case "FAN_IN_MET":
      return STATION_COLOR.brief
    default: {
      const c = (STATION_COLOR as Record<string, string>)[e.toLane]
      return c ?? "#e5e5e5"
    }
  }
}

export function eventSummary(e: JournalEvent): string {
  const lane =
    e.fromLane && e.toLane && e.fromLane !== e.toLane
      ? `${e.fromLane}→${e.toLane}`
      : e.toLane
  return `${e.event} ${e.cardId} ${lane}`
}
