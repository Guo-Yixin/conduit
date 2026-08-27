"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  JOURNAL,
  NOW_SEC,
  projectHeader,
  projectRows,
  type CardRow,
  type HeaderStats,
  type JournalEvent,
} from "@/lib/warroom-data"

export type Mode = "live" | "replay"

export type WarroomState = {
  mode: Mode
  nowSec: number
  visibleEvents: JournalEvent[]
  rows: CardRow[]
  header: HeaderStats
  latestEvent: JournalEvent | null
  prevEvents: JournalEvent[]
  // replay controls
  seq: number
  maxSeq: number
  playing: boolean
  enterReplay: () => void
  goLive: () => void
  play: () => void
  pause: () => void
  step: (dir: 1 | -1) => void
  seek: (seq: number) => void
}

const MAX_SEQ = JOURNAL.length

export function useWarroom(): WarroomState {
  const [mode, setMode] = useState<Mode>("live")
  // live clock advances rightward beyond NOW_SEC to show growth
  const [liveNow, setLiveNow] = useState(NOW_SEC)
  const [seq, setSeq] = useState(MAX_SEQ)
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number | null>(null)

  // Live clock tick — grows NOW rightward, ticks held countdown.
  useEffect(() => {
    if (mode !== "live") return
    const id = setInterval(() => {
      setLiveNow((n) => (n >= 78 ? NOW_SEC : n + 1))
    }, 1000)
    return () => clearInterval(id)
  }, [mode])

  // Replay autoplay — advance seq on a timer.
  useEffect(() => {
    if (mode !== "replay" || !playing) return
    const id = setInterval(() => {
      setSeq((s) => {
        if (s >= MAX_SEQ) {
          setPlaying(false)
          return s
        }
        return s + 1
      })
    }, 700)
    return () => clearInterval(id)
  }, [mode, playing])

  const enterReplay = useCallback(() => {
    setMode("replay")
    setPlaying(false)
    setSeq((s) => (s === MAX_SEQ ? 1 : s))
  }, [])

  const goLive = useCallback(() => {
    setMode("live")
    setPlaying(false)
    setLiveNow(NOW_SEC)
  }, [])

  const play = useCallback(() => setPlaying(true), [])
  const pause = useCallback(() => setPlaying(false), [])
  const step = useCallback((dir: 1 | -1) => {
    setPlaying(false)
    setSeq((s) => Math.min(MAX_SEQ, Math.max(1, s + dir)))
  }, [])
  const seek = useCallback((s: number) => {
    setPlaying(false)
    setSeq(Math.min(MAX_SEQ, Math.max(1, s)))
  }, [])

  const visibleEvents = useMemo(() => {
    if (mode === "live") return JOURNAL
    return JOURNAL.filter((e) => e.seq <= seq)
  }, [mode, seq])

  const nowSec = useMemo(() => {
    if (mode === "live") return liveNow
    const evs = visibleEvents
    const maxT = evs.length ? Math.max(...evs.map((e) => e.tSec)) : 0
    return Math.max(maxT, 1)
  }, [mode, liveNow, visibleEvents])

  const rows = useMemo(
    () => projectRows(visibleEvents, nowSec),
    [visibleEvents, nowSec],
  )

  const header = useMemo(
    () => projectHeader(visibleEvents, rows, nowSec),
    [visibleEvents, rows, nowSec],
  )

  const orderedVisible = useMemo(
    () => visibleEvents.slice().sort((a, b) => a.seq - b.seq),
    [visibleEvents],
  )
  const latestEvent =
    orderedVisible.length > 0 ? orderedVisible[orderedVisible.length - 1] : null
  const prevEvents = orderedVisible.slice(-4, -1).reverse()

  return {
    mode,
    nowSec,
    visibleEvents,
    rows,
    header,
    latestEvent,
    prevEvents,
    seq: mode === "replay" ? seq : MAX_SEQ,
    maxSeq: MAX_SEQ,
    playing,
    enterReplay,
    goLive,
    play,
    pause,
    step,
    seek,
  }
}
