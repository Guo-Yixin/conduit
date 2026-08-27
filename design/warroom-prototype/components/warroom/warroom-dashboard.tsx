"use client"

import { useState } from "react"
import { useWarroom } from "@/hooks/use-warroom"
import { WarroomHeader } from "@/components/warroom/warroom-header"
import { TimelineWaterfall } from "@/components/warroom/timeline-waterfall"
import { CardDetail } from "@/components/warroom/card-detail"
import { WarroomFooter } from "@/components/warroom/warroom-footer"
import { TuiPanel } from "@/components/warroom/tui-panel"

export function WarroomDashboard() {
  const state = useWarroom()
  const [selectedId, setSelectedId] = useState<string | null>("c-004")

  const selectedRow =
    state.rows.find((r) => r.id === selectedId) ?? null

  return (
    <div className="flex h-screen flex-col gap-1.5 bg-black p-1.5 text-neutral-200">
      <WarroomHeader header={state.header} mode={state.mode} />

      <div className="flex min-h-0 flex-1 gap-1.5">
        <TuiPanel
          title="TIMELINE"
          className="min-w-0 flex-1"
          right={
            <span className="text-neutral-500">
              t{state.nowSec}s · {state.rows.length} cards
            </span>
          }
        >
          <TimelineWaterfall
            rows={state.rows}
            nowSec={state.nowSec}
            mode={state.mode}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </TuiPanel>

        <TuiPanel
          title="CARD DETAIL"
          className="w-[340px] shrink-0"
          right={
            selectedRow ? (
              <span className="text-neutral-500">{selectedRow.id}</span>
            ) : null
          }
        >
          <CardDetail
            row={selectedRow}
            onClose={() => setSelectedId(null)}
          />
        </TuiPanel>
      </div>

      <WarroomFooter state={state} />
    </div>
  )
}
