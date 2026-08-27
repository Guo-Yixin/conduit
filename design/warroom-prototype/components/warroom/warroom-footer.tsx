"use client"

import {
  eventColor,
  eventSummary,
  type JournalEvent,
} from "@/lib/warroom-data"
import type { WarroomState } from "@/hooks/use-warroom"
import { cn } from "@/lib/utils"

function agoLabel(e: JournalEvent, nowSec: number): string {
  const d = Math.max(0, nowSec - e.tSec)
  return `${d}s ago`
}

export function WarroomFooter({ state }: { state: WarroomState }) {
  const { mode, latestEvent, prevEvents, nowSec } = state

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border border-neutral-800 bg-black px-3 text-[11px]">
      {mode === "live" ? (
        <LiveTicker
          latest={latestEvent}
          prev={prevEvents}
          nowSec={nowSec}
        />
      ) : (
        <Scrubber state={state} />
      )}

      {/* right side: live/replay toggle */}
      <div className="ml-auto flex items-center gap-2">
        {mode === "live" ? (
          <>
            <span className="flex items-center gap-1" style={{ color: "#39ff14" }}>
              <span className="wr-blink">●</span>
              <span className="font-bold tracking-wider">LIVE</span>
            </span>
            <button
              onClick={state.enterReplay}
              className="border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-[#00e5ff] hover:text-[#00e5ff]"
              aria-label="enter replay"
            >
              ⏮ replay
            </button>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1" style={{ color: "#00e5ff" }}>
              <span className="font-bold tracking-wider">REPLAY</span>
            </span>
            <button
              onClick={state.goLive}
              className="border px-2 py-0.5"
              style={{ borderColor: "#39ff14", color: "#39ff14" }}
              aria-label="go live"
            >
              go live ▶▶
            </button>
          </>
        )}
      </div>
    </footer>
  )
}

function LiveTicker({
  latest,
  prev,
  nowSec,
}: {
  latest: JournalEvent | null
  prev: JournalEvent[]
  nowSec: number
}) {
  if (!latest) return <span className="text-neutral-600">waiting for events…</span>
  return (
    <div className="flex min-w-0 items-center gap-3 overflow-hidden">
      <span className="text-neutral-600">tail -f</span>
      <span
        key={latest.seq}
        className="wr-ticker-in flex items-center gap-1 truncate font-bold"
        style={{ color: eventColor(latest) }}
      >
        {eventSummary(latest)}
        <span className="font-normal text-neutral-500">
          · {agoLabel(latest, nowSec)}
        </span>
      </span>
      {prev.map((e) => (
        <span
          key={e.seq}
          className="hidden truncate text-neutral-700 md:inline"
        >
          {eventSummary(e)}
        </span>
      ))}
    </div>
  )
}

function Scrubber({ state }: { state: WarroomState }) {
  const { seq, maxSeq, playing, visibleEvents } = state
  const current = visibleEvents
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .at(-1)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex items-center gap-1">
        <button
          onClick={() => state.step(-1)}
          className="border border-neutral-700 px-1.5 text-neutral-300 hover:text-[#00e5ff]"
          aria-label="step back"
        >
          ⏪
        </button>
        {playing ? (
          <button
            onClick={state.pause}
            className="border border-neutral-700 px-1.5 text-neutral-300 hover:text-[#00e5ff]"
            aria-label="pause"
          >
            ⏸
          </button>
        ) : (
          <button
            onClick={state.play}
            className="border border-neutral-700 px-1.5 text-neutral-300 hover:text-[#00e5ff]"
            aria-label="play"
          >
            ▶
          </button>
        )}
        <button
          onClick={() => state.step(1)}
          className="border border-neutral-700 px-1.5 text-neutral-300 hover:text-[#00e5ff]"
          aria-label="step forward"
        >
          ⏩
        </button>
      </div>

      <input
        type="range"
        min={1}
        max={maxSeq}
        value={seq}
        onChange={(e) => state.seek(Number(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none bg-neutral-800 accent-[#00e5ff]"
        aria-label="replay position"
      />

      <span className="shrink-0 whitespace-nowrap text-neutral-500">
        seq {seq}/{maxSeq}
        {current && (
          <span className="ml-2" style={{ color: eventColor(current) }}>
            {current.event} {current.cardId}
          </span>
        )}
      </span>
    </div>
  )
}
