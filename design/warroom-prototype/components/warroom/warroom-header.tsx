"use client"

import {
  TOK_BUDGET,
  WALL_BUDGET_SEC,
  WATCHDOG_THRESHOLD_SEC,
  type HeaderStats,
} from "@/lib/warroom-data"

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

function meterColor(pct: number): string {
  if (pct >= 1) return "#ff3b30"
  if (pct >= 0.8) return "#ffe600"
  return "#39ff14"
}

// Block meter: filled cells in state color, empty cells dim.
function BlockMeter({
  filled,
  total,
  color,
}: {
  filled: number
  total: number
  color: string
}) {
  const cells = Array.from({ length: total }, (_, i) => i < filled)
  return (
    <span className="tracking-[-1px]" aria-hidden>
      {cells.map((on, i) => (
        <span key={i} style={{ color: on ? color : "#2a2a2a" }}>
          {on ? "█" : "░"}
        </span>
      ))}
    </span>
  )
}

export function WarroomHeader({
  header,
  mode,
}: {
  header: HeaderStats
  mode: "live" | "replay"
}) {
  // every value below is a projection of the visible journal slice — in replay
  // it shows the run as of the scrub position, never the live head.
  const wallSec = header.wallSec
  const tokUsed = header.tokUsed
  const wallPct = wallSec / WALL_BUDGET_SEC
  const tokPct = tokUsed / TOK_BUDGET
  const wallCells = 15
  const tokCells = 15

  const done = header.done
  const scrap = header.scrap
  const held = header.held
  const totalCost = header.totalCost

  // watchdog — time since last event; null when no events yet
  const lastProgress = header.lastProgressSec
  const wdCells = 12
  const wdFilled =
    lastProgress == null
      ? 0
      : Math.min(
          wdCells,
          Math.round((lastProgress / WATCHDOG_THRESHOLD_SEC) * wdCells),
        )

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border border-neutral-800 bg-black px-4 py-2 text-[12px]">
      {/* left: title + running */}
      <div className="flex items-center gap-2">
        <span className="font-bold tracking-widest text-neutral-100">
          WAR ROOM
        </span>
        <span className="text-neutral-600">▮</span>
        <span className="text-neutral-400">branching</span>
        {mode === "live" ? (
          <span className="ml-3 flex items-center gap-1" style={{ color: "#39ff14" }}>
            <span className="wr-blink">●</span>
            <span className="font-bold tracking-wider">RUNNING</span>
          </span>
        ) : (
          <span className="ml-3 flex items-center gap-1" style={{ color: "#00e5ff" }}>
            <span className="font-bold tracking-wider">REPLAY @ t{wallSec}s</span>
          </span>
        )}
      </div>

      {/* center: budget meters */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-neutral-500">WALL</span>
          <span>[</span>
          <BlockMeter
            filled={Math.round(wallPct * wallCells)}
            total={wallCells}
            color={meterColor(wallPct)}
          />
          <span>]</span>
          <span className="text-neutral-300">
            {fmtClock(wallSec)}/{fmtClock(WALL_BUDGET_SEC)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-neutral-500">TOK</span>
          <span>[</span>
          <BlockMeter
            filled={Math.round(tokPct * tokCells)}
            total={tokCells}
            color={meterColor(tokPct)}
          />
          <span>]</span>
          <span className="text-neutral-300">
            {(tokUsed / 1000).toFixed(1)}k/{TOK_BUDGET / 1000}k
          </span>
        </div>
      </div>

      {/* watchdog */}
      <div className="flex items-center gap-2">
        <span className="text-neutral-500">LAST PROGRESS</span>
        {lastProgress == null ? (
          <span className="text-neutral-600">— no events yet —</span>
        ) : (
          <>
            <span style={{ color: meterColor(lastProgress / WATCHDOG_THRESHOLD_SEC) }}>
              {lastProgress}s
            </span>
            <span aria-hidden className="tracking-[-1px]">
              {Array.from({ length: wdCells }, (_, i) => (
                <span key={i} style={{ color: i < wdFilled ? "#ffe600" : "#2a2a2a" }}>
                  {i < wdFilled ? "▮" : "▯"}
                </span>
              ))}
            </span>
          </>
        )}
      </div>

      {/* right: counts */}
      <div className="ml-auto flex items-center gap-3">
        <Count label="DONE" value={done} color="#39ff14" />
        <span className="text-neutral-700">·</span>
        <Count label="SCRAP" value={scrap} color="#ff3b30" />
        <span className="text-neutral-700">·</span>
        <Count label="HELD" value={held} color="#ffb000" />
        <span className="text-neutral-700">·</span>
        <span className="font-bold text-neutral-100">${totalCost.toFixed(2)}</span>
      </div>
    </header>
  )
}

function Count({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: string
}) {
  return (
    <span className="flex items-center gap-1" style={{ color }}>
      <span className="text-neutral-500">{label}</span>
      <span className="font-bold">{value}</span>
    </span>
  )
}
