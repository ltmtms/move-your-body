import type { BodyFrame, Chart, Difficulty, Judgment, Note, PalmSample, Side, Stats, Vec } from './types.ts'
import type { View } from './view.ts'

export type Grade = 'S+++' | 'S++' | 'S+' | 'S' | 'A' | 'B' | 'C'

/** minimum timing accuracy (0–1) per grade */
export const GRADE_TABLE: [Grade, number][] = [
  ['S+++', 0.98],
  ['S++', 0.95],
  ['S+', 0.92],
  ['S', 0.88],
  ['A', 0.8],
  ['B', 0.65],
  ['C', 0],
]

/**
 * Grade from timing accuracy alone (PERFECT 1, GREAT 0.6, GOOD 0.3, MISS 0
 * per saucer). Combo and SLAP bonuses raise the score but not the grade, so
 * a high rank needs genuinely on-beat hits. S+++ also needs zero misses.
 */
export function gradeFor(stats: Stats): Grade {
  if (stats.judged <= 0) return 'C'
  const r = stats.accuracy / stats.judged
  for (const [g, min] of GRADE_TABLE) {
    if (g === 'S+++' && stats.miss > 0) continue
    if (r >= min) return g
  }
  return 'C'
}

const WEIGHT: Record<Judgment, number> = { perfect: 1, great: 0.6, good: 0.3, miss: 0 }
const BASE_POINTS = 1000
const SLAP_BONUS = 250
/** palm speed (shoulder widths / s) that earns the SLAP bonus */
export const SLAP_SPEED = 3.2

/**
 * Minimum palm speed (shoulder widths / s) for a touch to count as a slap at
 * all. A palm that just sits on a saucer never scores. 1 shoulder width is
 * ~40 cm, so EASY accepts a gentle wave (~0.3 m/s), NORMAL needs a clear
 * swipe (~0.65 m/s), HARD a quick one (~1 m/s).
 */
export const MIN_SWIPE: Record<Difficulty, number> = { easy: 0.8, normal: 1.6, hard: 2.4 }

/** how far ahead (s) a palm's path is extrapolated to cue an on-beat drum */
const CUE_AHEAD = 0.22

/** palm samples this far back (ms) are used to measure swipe speed */
const SPEED_WINDOW_MS = 140

export interface NoteState extends Note {
  state: 'pending' | 'hit' | 'miss'
  /** smallest |timing error| seen while the palm touched the saucer */
  best: number | null
  bestSlap: boolean
  touching: boolean
  /** which palm made the best contact */
  hand?: Side
  /** the palm touched it in time but was too still to count as a slap */
  slow?: boolean
  /** its drum is already scheduled on the beat (see cue) */
  cued?: Side
  judgment?: Judgment
  slap?: boolean
  /** where/when it was resolved, for effects */
  at?: Vec
  resolvedAt?: number
}

export interface HitEvent {
  note: NoteState
  judgment: Judgment
  slap: boolean
  pos: Vec
  offset: number
  side: Side | null
  /** miss because the palm rested on the saucer instead of slapping it */
  tooSlow?: boolean
}

export class Engine {
  notes: NoteState[]
  stats: Stats = {
    score: 0,
    combo: 0,
    maxCombo: 0,
    perfect: 0,
    great: 0,
    good: 0,
    miss: 0,
    slaps: 0,
    judged: 0,
    accuracy: 0,
  }
  /** seconds a saucer is visible before reaching its target */
  readonly lead: number
  /** last committed palm sample per hand, for swept collision */
  private prev: Record<Side, PalmSample | null> = { L: null, R: null }
  /** recent palm samples per hand, to measure swipe speed over ~140 ms */
  private recent: Record<Side, PalmSample[]> = { L: [], R: [] }
  private cursor = 0
  onEvent: ((e: HitEvent) => void) | null = null
  /** wall clock (ms); replaceable for simulations */
  clock: () => number = () => performance.now()
  /** a palm is about to hit this saucer: schedule its drum on the beat */
  onCue: ((n: NoteState, side: Side) => void) | null = null
  frameInterval = 33

  private view: View
  private toSong: (perfMs: number) => number

  private difficulty: Difficulty

  constructor(chart: Chart, lead: number, view: View, toSong: (perfMs: number) => number, difficulty: Difficulty) {
    this.difficulty = difficulty
    this.notes = chart.notes.map((n) => ({ ...n, state: 'pending', best: null, bestSlap: false, touching: false }))
    this.lead = lead
    this.view = view
    this.toSong = toSong
  }

  /** timing windows widen by half a camera frame: at 15 fps we can't do better */
  windows(): { perfect: number; great: number; good: number } {
    const half = Math.min(0.05, this.frameInterval / 2000)
    return { perfect: 0.06 + half, great: 0.11 + half, good: 0.18 + half }
  }

  /** slowest palm speed that still counts as a slap; relaxed a little on slow cameras */
  minSwipe(): number {
    return MIN_SWIPE[this.difficulty] * (this.frameInterval >= 60 ? 0.75 : 1)
  }

  /**
   * Palm speed in shoulder widths / s. The latest segment catches a sharp
   * slap; the displacement over the last ~140 ms rejects tracker jitter,
   * which averages out to nearly nothing when the hand is really still.
   */
  private swipeSpeed(side: Side, cur: PalmSample, a: PalmSample, ta: number, tb: number, unit: number): number {
    const hist = this.recent[side]
    hist.push(cur)
    while (hist.length > 1 && cur.t - hist[0].t > SPEED_WINDOW_MS) hist.shift()
    const old = hist[0]
    const span = (cur.t - old.t) / 1000
    const windowSpeed = span >= 0.05 ? Math.hypot(cur.x - old.x, cur.y - old.y) / span / unit : 0
    const seg = tb - ta
    const len = Math.hypot(cur.x - a.x, cur.y - a.y)
    // a segment shorter than ~8% of a shoulder width is tracker noise, not a swing
    const segSpeed = a !== cur && seg >= 0.02 && len >= unit * 0.08 ? len / seg / unit : 0
    return Math.max(windowSpeed, segSpeed)
  }

  layout(frame: BodyFrame | null): { anchor: Vec; shoulder: number } {
    if (frame?.anchor && frame.shoulder > 0) return { anchor: frame.anchor, shoulder: frame.shoulder }
    return this.view.fallbackAnchor()
  }

  targetOf(n: Note, frame: BodyFrame | null): Vec {
    const { anchor, shoulder } = this.layout(frame)
    return this.view.slotToScreen(n.slot, anchor, shoulder)
  }

  /** notes in [from, to] song time (cursor skips resolved history) */
  *active(from: number, to: number): Generator<NoteState> {
    while (this.cursor < this.notes.length && this.notes[this.cursor].state !== 'pending' && this.notes[this.cursor].time < from - 1)
      this.cursor++
    for (let i = this.cursor; i < this.notes.length; i++) {
      const n = this.notes[i]
      if (n.time > to) break
      if (n.time >= from) yield n
    }
  }

  /**
   * Called for every processed camera frame.
   *
   * Fast slaps: at 15–30 fps a palm can jump 30 cm between two frames and
   * skip right over a saucer. So instead of testing points we test the swept
   * path between consecutive palm samples (sub-sampled), interpolate the time
   * of contact along that path, and measure the swing speed – a fast swipe
   * through the saucer counts as a SLAP for bonus points.
   */
  onBody(frame: BodyFrame): void {
    const w = this.windows()
    const { shoulder } = this.layout(frame)
    const unit = this.view.unit(shoulder)
    const hitR = this.view.saucerRadius(shoulder) + unit * 0.22
    const songNow = this.toSong(frame.t)
    const touchedNow = new Set<NoteState>()

    for (const side of ['L', 'R'] as Side[]) {
      const cur = frame.palms[side]
      const prev = this.prev[side]
      this.prev[side] = cur
      if (!cur) {
        this.recent[side].length = 0
        continue
      }
      const a = prev && cur.t - prev.t < 250 ? prev : cur
      const ta = this.toSong(a.t)
      const tb = this.toSong(cur.t)
      const speed = this.swipeSpeed(side, cur, a, ta, tb, unit)
      const moving = speed >= this.minSwipe()

      for (const n of this.active(ta - w.good, tb + w.good)) {
        if (n.state !== 'pending') continue
        const p = this.targetOf(n, frame)
        // sweep the segment a→cur in small steps, collecting contact times
        const steps = a === cur ? 1 : Math.min(12, 2 + Math.ceil(Math.hypot(cur.x - a.x, cur.y - a.y) / (hitR * 0.5)))
        let touched = false
        let closest = Infinity
        let tClosest = tb
        let kClosest = 0
        const r = n.touching ? hitR * 1.2 : hitR
        for (let k = 0; k <= steps; k++) {
          const u = k / steps
          const x = a.x + (cur.x - a.x) * u
          const y = a.y + (cur.y - a.y) * u
          const d = Math.hypot(x - p.x, y - p.y)
          const t = ta + (tb - ta) * u
          if (d < closest) {
            closest = d
            tClosest = t
            kClosest = k
          }
          if (d <= r) touched = true
        }
        if (!touched) continue
        touchedNow.add(n)
        // resting on the saucer is not a slap: remember it for the feedback
        if (!moving) {
          n.slow = true
          continue
        }
        const slap = speed >= SLAP_SPEED
        // swinging away from a saucer it already passed: that pass was timed
        // by the previous segment, the tail end here would read too late/early
        if (a !== cur && kClosest === 0) continue
        // a slap is timed at its closest pass
        const off = Math.abs(n.time - tClosest)
        if (off > w.good) continue
        if (n.best === null || off < n.best - 0.01 || (Math.abs(off - n.best) <= 0.01 && slap)) {
          n.best = off
          n.bestSlap = slap
          n.hand = side
        }
        n.at = { x: cur.x, y: cur.y }
        if (n.best <= 0.02) this.resolve(n, side, frame)
      }
    }

    this.cue(frame, hitR, unit)

    // release: the palm left a saucer it had touched → lock in the best timing
    for (const n of this.active(songNow - w.good - 0.5, songNow + w.good)) {
      if (n.state !== 'pending') continue
      if (n.touching && !touchedNow.has(n) && n.best !== null) this.resolve(n, null, frame)
      else n.touching = touchedNow.has(n)
      // waiting on the saucer: the best is still to come until its time passes
      if (n.state === 'pending' && n.best !== null && songNow > n.time + w.perfect * 0.5) this.resolve(n, null, frame)
    }
  }

  /**
   * On-beat drums. The camera reports a hit ~100 ms after it happens, so a
   * drum played on detection always lands late. When a moving palm is on
   * course to reach a saucer (extrapolated along its velocity to the
   * saucer's time), its drum is scheduled for the exact beat instead.
   */
  private cue(frame: BodyFrame, hitR: number, unit: number): void {
    const realNow = this.toSong(this.clock())
    for (const n of this.active(realNow + 0.01, this.toSong(frame.t) + CUE_AHEAD)) {
      if (n.state !== 'pending' || n.cued) continue
      const p = this.targetOf(n, frame)
      for (const side of ['L', 'R'] as Side[]) {
        const cur = frame.palms[side]
        if (!cur) continue
        const ahead = Math.min(CUE_AHEAD, Math.max(0, n.time - this.toSong(cur.t)))
        const speed = Math.hypot(cur.vx, cur.vy) / unit
        const x = cur.x + cur.vx * ahead
        const y = cur.y + cur.vy * ahead
        if (speed >= this.minSwipe() && Math.hypot(x - p.x, y - p.y) <= hitR) {
          n.cued = side
          this.onCue?.(n, side)
          break
        }
      }
    }
  }

  /** called every render frame: expire saucers nobody touched */
  update(songNow: number): void {
    const w = this.windows()
    for (const n of this.active(songNow - 5, songNow)) {
      if (n.state === 'pending' && songNow > n.time + w.good) this.resolve(n, null, null)
    }
  }

  private resolve(n: NoteState, side: Side | null, frame: BodyFrame | null): void {
    const w = this.windows()
    let j: Judgment = 'miss'
    if (n.best !== null) j = n.best <= w.perfect ? 'perfect' : n.best <= w.great ? 'great' : 'good'
    n.state = j === 'miss' ? 'miss' : 'hit'
    n.judgment = j
    n.slap = j !== 'miss' && n.bestSlap
    n.resolvedAt = performance.now()
    const pos = j === 'miss' ? this.targetOf(n, frame) : (n.at ?? this.targetOf(n, frame))

    const s = this.stats
    s.judged++
    s.accuracy += WEIGHT[j]
    if (j === 'miss') {
      s.miss++
      s.combo = 0
    } else {
      s[j]++
      s.combo++
      s.maxCombo = Math.max(s.maxCombo, s.combo)
      s.score += Math.round(BASE_POINTS * WEIGHT[j] * (1 + Math.min(s.combo - 1, 50) / 50))
      if (n.slap) {
        s.slaps++
        s.score += SLAP_BONUS
      }
    }
    this.onEvent?.({
      note: n,
      judgment: j,
      slap: !!n.slap,
      pos,
      offset: n.best ?? 0,
      side: side ?? n.hand ?? null,
      tooSlow: j === 'miss' && !!n.slow,
    })
  }

  get finished(): boolean {
    return this.notes.every((n) => n.state !== 'pending')
  }
}
