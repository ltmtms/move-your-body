export type Side = 'L' | 'R'
export type Difficulty = 'easy' | 'normal' | 'hard'
export type Judgment = 'perfect' | 'great' | 'good' | 'miss'

/** A target slot in body space: units of shoulder width, origin = shoulder midpoint. */
export interface Slot {
  x: number
  y: number
}

export interface Note {
  id: number
  /** song time (s) the saucer reaches its target */
  time: number
  side: Side
  slot: Slot
  /** notes sharing a group must be hit together (double saucers) */
  group: number
  strength: number
  /** position in the bar: 0 = downbeat, 1–3 = other beats, -1 = off-beat */
  beat: number
  /** percussion kit of the song section this note is in */
  kit: number
  /** also crash a cymbal on this hit (phrase starts, double saucers) */
  cymbal: boolean
}

export interface Section {
  start: number
  kit: number
}

export interface Chart {
  bpm: number
  duration: number
  beats: number[]
  /** times of bar starts (detected downbeats) */
  downbeats: number[]
  /** share of beats (0–1) locked to a steady BPM grid */
  steady: number
  /** ≤ 4 song sections, each with its own percussion kit */
  sections: Section[]
  notes: Note[]
}

export interface Vec {
  x: number
  y: number
}

/** One tracked palm sample in screen CSS pixels. */
export interface PalmSample extends Vec {
  /** performance.now() of the camera frame */
  t: number
  /** px / s */
  vx: number
  vy: number
  /** true when the position is dead-reckoned through a motion-blurred frame */
  predicted: boolean
}

export interface BodyFrame {
  t: number
  /** shoulder midpoint in screen px */
  anchor: Vec | null
  /** shoulder width in screen px */
  shoulder: number
  palms: Record<Side, PalmSample | null>
  /** upper-body joints for the neon skeleton overlay */
  joints: (Vec | null)[]
}

export interface Stats {
  score: number
  combo: number
  maxCombo: number
  perfect: number
  great: number
  good: number
  miss: number
  slaps: number
  judged: number
  /** best possible score for the notes judged so far */
  /** sum of per-saucer timing scores (PERFECT 1, GREAT 0.6, GOOD 0.3) */
  accuracy: number
}
