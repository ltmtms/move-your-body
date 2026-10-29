export type Lane = 'left' | 'right'

export interface BeatNote {
  id: number
  /** Seconds from track start when the note should be hit */
  hitTime: number
  lane: Lane
  /** Set during gameplay */
  state: 'pending' | 'hit' | 'miss'
}

export interface HandPositions {
  left: { x: number; y: number; score: number } | null
  right: { x: number; y: number; score: number } | null
}

export interface GameStats {
  score: number
  combo: number
  maxCombo: number
  perfect: number
  good: number
  miss: number
}

export type Judgment = 'perfect' | 'good' | 'miss'

export interface JudgmentFlash {
  judgment: Judgment
  lane: Lane
  until: number
}
