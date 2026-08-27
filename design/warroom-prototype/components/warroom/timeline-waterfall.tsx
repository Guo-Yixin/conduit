"use client"

import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import {
  HELD_COLOR,
  STATION_COLOR,
  STATIONS,
  WALL_BUDGET_SEC,
  heldSecondsLeft,
  isHeldOverdue,
  type CardRow,
  type Segment,
  type Station,
} from "@/lib/warroom-data"
import { cn } from "@/lib/utils"

const GUTTER_W = 168 // px, fixed left label column
const ROW_H = 30
const MIN_SEG_W = 3 // px, segments never thinner than this

type Tx = {
  toX: (sec: number) => number
  pxPerSec: number
}

function stationColor(s: Station) {
  return STATION_COLOR[s]
}

// One station-visit segment rendered as a chunky slab.
function SegmentBar({
  seg,
  isWorkingTail,
  tx,
}: {
  seg: Segment
  isWorkingTail: boolean
  tx: Tx
}) {
  const left = tx.toX(seg.startSec)
  const width = Math.max(MIN_SEG_W, (seg.endSec - seg.startSec) * tx.pxPerSec)
  const color = stationColor(seg.station)
  return (
    <div
      className={cn(
        "absolute top-1/2 flex -translate-y-1/2 items-center overflow-hidden",
        isWorkingTail && "wr-pulse-hot",
      )}
      style={{
        left,
        width,
        height: 16,
        backgroundColor: color,
        outline: seg.rework ? `1px dashed rgba(0,0,0,0.55)` : undefined,
        outlineOffset: seg.rework ? -3 : undefined,
      }}
      title={`${seg.station} ${seg.startSec}s–${seg.endSec}s${seg.rework ? " (rework)" : ""}`}
    >
      {width > 10 && (
        <span
          className="select-none whitespace-nowrap px-1 text-[10px] font-bold leading-none tracking-[-1px]"
          style={{ color: "rgba(0,0,0,0.7)", mixBlendMode: "multiply" }}
        >
          {"█".repeat(Math.max(1, Math.floor(width / 7)))}
        </span>
      )}
    </div>
  )
}

function Cap({
  left,
  kind,
  label,
}: {
  left: number
  kind: "scrap" | "complete"
  label: string
}) {
  const color = kind === "scrap" ? "#ff3b30" : "#39ff14"
  const glyph = kind === "scrap" ? "×" : "✓"
  return (
    <div
      className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap pl-1"
      style={{ left }}
    >
      <span
        className="px-1 text-[12px] font-bold leading-none"
        style={{ color, backgroundColor: kind === "scrap" ? "rgba(255,59,48,0.15)" : "transparent" }}
      >
        {glyph} {label}
      </span>
    </div>
  )
}

function ReworkMarkers({ row, tx }: { row: CardRow; tx: Tx }) {
  let n = 0
  return (
    <>
      {row.segments.map((seg, i) => {
        if (!seg.rework) return null
        n += 1
        const left = tx.toX(seg.startSec)
        return (
          <div
            key={i}
            className="absolute -top-[2px] z-20 whitespace-nowrap text-[9px] font-bold leading-none"
            style={{ left, color: "#ff2d78", transform: "translateX(-2px)" }}
          >
            ↩ rework {n}/{row.reworkCap}
          </div>
        )
      })}
    </>
  )
}

function TimelineRow({
  row,
  tx,
  nowSec,
  selected,
  onSelect,
  isLastChild,
}: {
  row: CardRow
  tx: Tx
  nowSec: number
  selected: boolean
  onSelect: (id: string) => void
  isLastChild: boolean
}) {
  const indent = row.depth * 16
  const tree = row.depth > 0 ? (isLastChild ? "└─" : "├─") : ""

  const lastSegIdx = row.segments.length - 1

  const heldLeft = row.heldFrom != null ? tx.toX(row.heldFrom) : 0
  const heldWidth =
    row.heldFrom != null
      ? Math.max(MIN_SEG_W, (nowSec - row.heldFrom) * tx.pxPerSec)
      : 0
  const secsLeft = heldSecondsLeft(nowSec)
  const overdue = isHeldOverdue(nowSec)

  const awFrom = row.awaitingFrom
  const awTo = row.awaitingTo ?? nowSec
  const awLeft = awFrom != null ? tx.toX(awFrom) : 0
  const awWidth = awFrom != null ? Math.max(4, (awTo - awFrom) * tx.pxPerSec) : 0

  const lastSeg = row.segments[lastSegIdx]
  const rowEndX = lastSeg ? tx.toX(lastSeg.endSec) : 0

  return (
    <div
      className={cn(
        "group relative flex cursor-pointer items-stretch border-b border-neutral-900/80 hover:bg-neutral-950",
        selected && "bg-neutral-900/70",
      )}
      style={{ height: ROW_H }}
      onClick={() => onSelect(row.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(row.id)
      }}
      aria-label={`card ${row.id}, state ${row.state}`}
    >
      {/* left gutter */}
      <div
        className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-neutral-800 bg-black px-2 text-[11px]"
        style={{ width: GUTTER_W }}
      >
        <span className="text-neutral-700" style={{ paddingLeft: indent }}>
          {tree}
        </span>
        <span
          className={cn(
            "font-bold",
            row.state === "scrapped" ? "text-neutral-500 line-through" : "text-neutral-100",
          )}
        >
          {row.id}
        </span>
        <span className="ml-auto text-neutral-500">${row.costUsd.toFixed(2)}</span>
      </div>

      {/* track */}
      <div className="relative min-w-0 flex-1">
        {/* awaiting children dotted line */}
        {awFrom != null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 border-t border-dashed"
            style={{ left: awLeft, width: awWidth, borderColor: "#666" }}
          />
        )}

        {/* station segments */}
        {row.segments.map((seg, i) => (
          <SegmentBar
            key={i}
            seg={seg}
            tx={tx}
            isWorkingTail={row.state === "working" && i === lastSegIdx}
          />
        ))}

        {/* rework markers */}
        {row.segments.some((s) => s.rework) && <ReworkMarkers row={row} tx={tx} />}

        {/* held amber bar */}
        {row.state === "held" && row.heldFrom != null && (
          <div
            className={cn(
              "absolute top-1/2 flex -translate-y-1/2 items-center gap-2 overflow-hidden px-2",
              overdue ? "wr-overdue" : "wr-amber",
            )}
            style={{ left: heldLeft, width: heldWidth, height: 18, backgroundColor: HELD_COLOR }}
          >
            <span className="whitespace-nowrap text-[10px] font-bold leading-none text-black">
              {overdue ? `${row.heldLabel} · OVERDUE` : `${row.heldLabel} · ${secsLeft}s left`}
            </span>
          </div>
        )}

        {/* fan-in label */}
        {row.fanInLabel && row.awaitingTo != null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-bold leading-none"
            style={{ left: tx.toX(row.awaitingTo) - 2, color: "#39ff14", transform: "translate(-100%, -50%)" }}
          >
            {row.fanInLabel}{" "}
          </div>
        )}

        {/* end caps */}
        {row.state === "scrapped" && <Cap left={rowEndX} kind="scrap" label="rework_cap" />}
        {row.state === "complete" && <Cap left={rowEndX} kind="complete" label="complete" />}
      </div>
    </div>
  )
}

// Fork connector: vertical bracket from a fan-out parent down to its children block.
function ForkConnector({
  parentIndex,
  childIndices,
  fanOutX,
}: {
  parentIndex: number
  childIndices: number[]
  fanOutX: number
}) {
  if (!childIndices.length) return null
  const top = parentIndex * ROW_H + ROW_H / 2
  const lastChild = childIndices[childIndices.length - 1]
  const bottom = lastChild * ROW_H + ROW_H / 2
  return (
    <svg
      className="pointer-events-none absolute z-20"
      style={{ left: fanOutX - 8, top: 0, width: 24, height: (lastChild + 1) * ROW_H }}
      aria-hidden
    >
      <path d={`M 8 ${top} L 8 ${bottom}`} stroke="#b388ff" strokeWidth="1.5" fill="none" />
      {childIndices.map((ci) => {
        const y = ci * ROW_H + ROW_H / 2
        return <path key={ci} d={`M 8 ${y} L 20 ${y}`} stroke="#b388ff" strokeWidth="1.5" fill="none" />
      })}
    </svg>
  )
}

// Minimap strip: full run + a box showing the current viewport. Only shown when zoomed.
function Minimap({
  fullStart,
  fullEnd,
  viewStart,
  viewEnd,
  onFit,
}: {
  fullStart: number
  fullEnd: number
  viewStart: number
  viewEnd: number
  onFit: () => void
}) {
  const span = Math.max(1, fullEnd - fullStart)
  const boxLeft = ((viewStart - fullStart) / span) * 100
  const boxW = ((viewEnd - viewStart) / span) * 100
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-neutral-800 px-2 py-1">
      <button
        onClick={onFit}
        className="shrink-0 border border-neutral-700 px-1.5 text-[10px] text-neutral-300 hover:border-[#00e5ff] hover:text-[#00e5ff]"
        aria-label="fit all"
      >
        ⤢ fit all
      </button>
      <div className="relative h-3 min-w-0 flex-1 bg-neutral-950">
        <div className="absolute inset-0 border border-neutral-900" />
        <div
          className="absolute inset-y-0 border border-[#00e5ff] bg-[#00e5ff]/20"
          style={{ left: `${boxLeft}%`, width: `${Math.max(2, boxW)}%` }}
        />
      </div>
    </div>
  )
}

export function TimelineWaterfall({
  rows,
  nowSec,
  selectedId,
  onSelect,
}: {
  rows: CardRow[]
  nowSec: number
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  // measure the track region width (= container width minus the gutter)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [trackW, setTrackW] = useState(800)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setTrackW(w)
    })
    ro.observe(el)
    setTrackW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Wall budget policy: axis fits t0→now, but once now passes 60% of budget the
  // wall enters the viewport so cards visibly approach it; at 100% it is the hard edge.
  const budget = WALL_BUDGET_SEC
  const showWall = nowSec > 0.6 * budget
  const fullStart = 0
  const fullEnd = showWall ? Math.max(budget, nowSec) : Math.max(nowSec, 1)

  // zoom view (null = fit all)
  const [view, setView] = useState<{ start: number; end: number } | null>(null)
  const isZoomed = view != null
  const viewStart = view ? view.start : fullStart
  const viewEnd = view ? view.end : fullEnd

  const span = Math.max(1, viewEnd - viewStart)
  const pxPerSec = trackW / span
  const toX = (sec: number) => (sec - viewStart) * pxPerSec
  const tx: Tx = { toX, pxPerSec }

  // drag-to-zoom selection (px relative to the track region)
  const [drag, setDrag] = useState<{ x0: number; x1: number; y: number } | null>(null)
  const secAtPx = useCallback(
    (px: number) => viewStart + (px / Math.max(1, trackW)) * span,
    [viewStart, span, trackW],
  )
  const onDragEnd = useCallback(() => {
    if (!drag) return
    const a = Math.min(drag.x0, drag.x1)
    const b = Math.max(drag.x0, drag.x1)
    const y = drag.y
    setDrag(null)
    if (b - a < 12) {
      // treat as a click: select the row under the cursor
      const idx = Math.floor(y / ROW_H)
      if (idx >= 0 && idx < rows.length) onSelect(rows[idx].id)
      return
    }
    const s = secAtPx(a)
    const e = secAtPx(b)
    if (e - s >= 1) setView({ start: s, end: e })
  }, [drag, secAtPx, rows, onSelect])

  // time ruler ticks — spaced to keep a readable number of labels at any zoom
  const tickStep = niceStep(span)
  const ticks: number[] = []
  for (let t = Math.ceil(viewStart / tickStep) * tickStep; t <= viewEnd; t += tickStep) {
    ticks.push(Math.round(t))
  }

  const indexById = new Map(rows.map((r, i) => [r.id, i]))
  const forks = rows
    .filter((r) => r.fanOutAt != null)
    .map((parent) => {
      const childIdx = rows
        .map((r, i) => ({ r, i }))
        .filter((x) => x.r.parentId === parent.id)
        .map((x) => x.i)
      return {
        parentIndex: indexById.get(parent.id)!,
        childIndices: childIdx,
        fanOutX: toX(parent.fanOutAt!),
      }
    })

  const wallX = toX(budget)
  const nowX = toX(nowSec)
  const wallVisible = showWall && wallX >= 0 && wallX <= trackW + 1

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* time ruler */}
      <div className="flex shrink-0 items-stretch border-b border-neutral-800 text-[10px] text-neutral-600">
        <div
          className="flex shrink-0 items-center border-r border-neutral-800 bg-black px-2 text-neutral-500"
          style={{ width: GUTTER_W }}
        >
          card · cost
        </div>
        <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-0 border-l border-neutral-900 pl-1 leading-5"
              style={{ left: toX(t) }}
            >
              {t}s
            </span>
          ))}
          {wallVisible && (
            <span
              className="absolute top-0 leading-5 text-[#ff3b30]"
              style={{ left: wallX, transform: "translateX(-100%)" }}
            >
              wall {budget}s ▶
            </span>
          )}
          <span className="absolute top-0 leading-5 text-[#39ff14]" style={{ left: nowX + 4 }}>
            ◀ now
          </span>
        </div>
      </div>

      {/* rows area (vertical scroll only — axis is compressed to fit) */}
      <div className="wr-scroll relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative">
          {/* track overlay: spans only the track region (offset by gutter) */}
          <div
            ref={trackRef}
            className="absolute bottom-0 top-0 z-30 select-none"
            style={{ left: GUTTER_W, right: 0 }}
            onMouseDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setDrag({
                x0: e.clientX - rect.left,
                x1: e.clientX - rect.left,
                y: e.clientY - rect.top,
              })
            }}
            onMouseMove={(e) => {
              if (!drag) return
              const rect = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect.left
              setDrag((d) => (d ? { ...d, x1: x } : d))
            }}
            onMouseUp={onDragEnd}
            onMouseLeave={() => drag && onDragEnd()}
          >
            {/* fork connectors */}
            {forks.map((f, i) => (
              <ForkConnector key={i} {...f} />
            ))}
            {/* wall line */}
            {wallVisible && (
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-px bg-[#ff3b30]"
                style={{ left: wallX, boxShadow: "0 0 6px rgba(255,59,48,0.6)" }}
              />
            )}
            {/* now line (green = alive) */}
            <div
              className="pointer-events-none absolute bottom-0 top-0 border-l border-[#39ff14]/60"
              style={{ left: nowX }}
            />
            {/* drag selection rectangle */}
            {drag && Math.abs(drag.x1 - drag.x0) > 2 && (
              <div
                className="pointer-events-none absolute bottom-0 top-0 z-40 border-x border-[#00e5ff] bg-[#00e5ff]/15"
                style={{ left: Math.min(drag.x0, drag.x1), width: Math.abs(drag.x1 - drag.x0) }}
              />
            )}
          </div>

          {/* rows */}
          {rows.map((row, i) => {
            const siblings = rows.filter((r) => r.parentId === row.parentId && r.depth > 0)
            const isLastChild =
              row.depth > 0 &&
              siblings.length > 0 &&
              siblings[siblings.length - 1].id === row.id
            return (
              <Fragment key={row.id}>
                <TimelineRow
                  row={row}
                  tx={tx}
                  nowSec={nowSec}
                  selected={selectedId === row.id}
                  onSelect={onSelect}
                  isLastChild={isLastChild}
                />
              </Fragment>
            )
          })}
        </div>
      </div>

      {/* minimap — only visible when zoomed */}
      {isZoomed && (
        <Minimap
          fullStart={fullStart}
          fullEnd={fullEnd}
          viewStart={viewStart}
          viewEnd={viewEnd}
          onFit={() => setView(null)}
        />
      )}

      {/* legend */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-800 px-3 py-1.5 text-[10px]">
        {STATIONS.map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-4" style={{ backgroundColor: STATION_COLOR[s] }} />
            <span className="text-neutral-400">{s}</span>
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3 text-neutral-500">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-4" style={{ backgroundColor: HELD_COLOR }} />
            held
          </span>
          <span className="flex items-center gap-1" style={{ color: "#ff3b30" }}>
            × scrapped
          </span>
          <span className="flex items-center gap-1" style={{ color: "#39ff14" }}>
            ✓ complete
          </span>
          <span className="text-neutral-700">·</span>
          <span className="text-neutral-600">drag to zoom</span>
        </span>
      </div>
    </div>
  )
}

function niceStep(span: number): number {
  const target = span / 7 // aim for ~7 ticks
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300]
  for (const s of steps) if (s >= target) return s
  return 600
}
