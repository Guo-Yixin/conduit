"use client"

import {
  eventColor,
  type CardRow,
  type JournalEvent,
} from "@/lib/warroom-data"
import { cn } from "@/lib/utils"

const DIM = "· not recorded ·"

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  const empty =
    value == null || value === "" || (Array.isArray(value) && value.length === 0)
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="w-24 shrink-0 text-neutral-500">{label}</span>
      {empty ? (
        <span className="text-neutral-700">{DIM}</span>
      ) : (
        <span className="text-neutral-200">{value}</span>
      )}
    </div>
  )
}

function EventLine({ e }: { e: JournalEvent }) {
  const color = eventColor(e)
  const lane =
    e.fromLane && e.toLane && e.fromLane !== e.toLane
      ? `${e.fromLane}→${e.toLane}`
      : e.toLane
  return (
    <div className="border-b border-neutral-900/70 py-1">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="w-10 shrink-0 text-neutral-600">t{e.tSec}s</span>
        <span className="w-8 shrink-0 text-neutral-700">#{e.seq}</span>
        <span className="font-bold" style={{ color }}>
          {e.event}
        </span>
        <span className="text-neutral-400">{lane}</span>
        {typeof e.costUsd === "number" && (
          <span className="ml-auto text-neutral-500">${e.costUsd.toFixed(2)}</span>
        )}
      </div>
      {e.findings && e.findings.length > 0 && (
        <ul className="mt-0.5 pl-12 text-[10px]">
          {e.findings.map((f, i) => (
            <li key={i} className="text-neutral-500">
              <span style={{ color }}>›</span> {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function CardDetail({
  row,
  onClose,
}: {
  row: CardRow | null
  onClose: () => void
}) {
  if (!row) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-neutral-600">
        select a card row
        <br />
        to inspect its event log
      </div>
    )
  }

  const stateColor: Record<string, string> = {
    scrapped: "#ff3b30",
    complete: "#39ff14",
    held: "#ffb000",
    working: "#ffffff",
    awaiting_children: "#b388ff",
    idle: "#888888",
  }

  const totalTokens = row.events.reduce((a, e) => a + (e.tokens ?? 0), 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2 text-[12px]">
        <span className="font-bold text-neutral-100">{row.id}</span>
        <span
          className="px-1.5 py-0.5 text-[10px] font-bold uppercase"
          style={{
            color: "#000",
            backgroundColor: stateColor[row.state] ?? "#888",
          }}
        >
          {row.state.replace(/_/g, " ")}
        </span>
        <span className="font-mono text-[10px] text-neutral-500">
          kernel:{" "}
          <span className="text-neutral-300">{row.status.replace(/_/g, " ")}</span>
        </span>
        <button
          onClick={onClose}
          className="ml-auto px-1 text-neutral-500 hover:text-neutral-200"
          aria-label="close detail"
        >
          [x]
        </button>
      </div>

      {/* counters */}
      <div className="shrink-0 space-y-1 border-b border-neutral-800 px-3 py-2">
        <Field label="rework" value={`${row.reworkCount ?? 0}/${row.reworkCap ?? 2}`} />
        <Field label="attempt" value={`${row.attempt ?? 1}/${row.attemptCap ?? 4}`} />
        <Field label="parent" value={row.parentId ?? "· root ·"} />
        <Field
          label="owned paths"
          value={
            row.ownedPaths && row.ownedPaths.length ? (
              <span className="flex flex-col">
                {row.ownedPaths.map((p) => (
                  <span key={p} className="text-neutral-300">
                    {p}
                  </span>
                ))}
              </span>
            ) : null
          }
        />
        <Field label="cost" value={`$${row.costUsd.toFixed(2)}`} />
        <Field
          label="tokens"
          value={totalTokens > 0 ? totalTokens.toLocaleString() : null}
        />
      </div>

      {/* event log */}
      <div className="wr-scroll min-h-0 flex-1 overflow-auto px-3 py-2">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-neutral-600">
          event log
        </div>
        {row.events.length === 0 ? (
          <div className="text-[11px] text-neutral-700">{DIM}</div>
        ) : (
          row.events
            .slice()
            .sort((a, b) => a.seq - b.seq)
            .map((e) => <EventLine key={e.seq} e={e} />)
        )}
      </div>
    </div>
  )
}
