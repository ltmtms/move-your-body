import type { BeatNote, GameStats, HandPositions, Judgment, JudgmentFlash, Lane } from './types.ts'
import { GameRenderer, LEAD_SEC } from './renderer.ts'

const PERFECT_WINDOW = 0.11
const GOOD_WINDOW = 0.2
const HIT_RADIUS = 0.12

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

export class GameEngine {
  private renderer: GameRenderer
  private notes: BeatNote[]
  private audio: HTMLAudioElement
  private audioStartWall = 0
  private playing = false
  private raf = 0
  private poseEstimate: () => Promise<HandPositions>
  private hands: HandPositions = { left: null, right: null }
  private poseBusy = false
  private stats: GameStats = {
    score: 0,
    combo: 0,
    maxCombo: 0,
    perfect: 0,
    good: 0,
    miss: 0,
  }
  private flashes: JudgmentFlash[] = []
  private bpm: number
  private onEnd: () => void

  constructor(opts: {
    renderer: GameRenderer
    notes: BeatNote[]
    audioBlobUrl: string
    bpm: number
    poseEstimate: () => Promise<HandPositions>
    onEnd: () => void
  }) {
    this.renderer = opts.renderer
    this.notes = opts.notes.map((n) => ({ ...n }))
    this.audio = new Audio(opts.audioBlobUrl)
    this.bpm = opts.bpm
    this.poseEstimate = opts.poseEstimate
    this.onEnd = opts.onEnd
  }

  async start(): Promise<void> {
    this.playing = true
    this.audioStartWall = performance.now() / 1000
    try {
      await this.audio.play()
    } catch {
      /* user gesture already happened */
    }
    this.schedulePose()
    this.raf = requestAnimationFrame(this.loop)
  }

  stop(): void {
    this.playing = false
    cancelAnimationFrame(this.raf)
    this.audio.pause()
  }

  getStats(): GameStats {
    return { ...this.stats }
  }

  private schedulePose(): void {
    if (!this.playing || this.poseBusy) return
    this.poseBusy = true
    void this.poseEstimate()
      .then((h) => {
        this.hands = h
      })
      .finally(() => {
        this.poseBusy = false
        if (this.playing) window.setTimeout(() => this.schedulePose(), 0)
      })
  }

  private songTime(): number {
    if (!this.playing) return 0
    if (!Number.isNaN(this.audio.currentTime) && this.audio.currentTime > 0) {
      return this.audio.currentTime
    }
    return performance.now() / 1000 - this.audioStartWall
  }

  private laneTargetNorm(lane: Lane): { x: number; y: number } {
    return { x: lane === 'left' ? 0.28 : 0.72, y: 0.72 }
  }

  private registerHit(note: BeatNote, judgment: Judgment): void {
    note.state = judgment === 'miss' ? 'miss' : 'hit'
    this.flashes.push({
      judgment,
      lane: note.lane,
      until: performance.now() + 600,
    })
    if (judgment === 'miss') {
      this.stats.combo = 0
      this.stats.miss++
    } else {
      this.stats.combo++
      this.stats.maxCombo = Math.max(this.stats.maxCombo, this.stats.combo)
      if (judgment === 'perfect') {
        this.stats.perfect++
        this.stats.score += 300 + this.stats.combo * 5
      } else {
        this.stats.good++
        this.stats.score += 150 + this.stats.combo * 2
      }
    }
  }

  private tryHit(note: BeatNote, hands: HandPositions, t: number): void {
    if (t > note.hitTime + GOOD_WINDOW) {
      this.registerHit(note, 'miss')
      return
    }
    if (t < note.hitTime - GOOD_WINDOW) return

    const hand = note.lane === 'left' ? hands.left : hands.right
    if (!hand) return

    const target = this.laneTargetNorm(note.lane)
    const d = dist(hand.x, hand.y, target.x, target.y)
    if (d > HIT_RADIUS) return

    const dt = Math.abs(t - note.hitTime)
    const judgment: Judgment = dt <= PERFECT_WINDOW ? 'perfect' : 'good'
    this.registerHit(note, judgment)
  }

  private loop = (): void => {
    if (!this.playing) return
    const t = this.songTime()
    const hands = this.hands

    for (const note of this.notes) {
      if (note.state !== 'pending') continue
      if (t < note.hitTime - LEAD_SEC) continue
      this.tryHit(note, hands, t)
    }

    this.flashes = this.flashes.filter((f) => f.until > performance.now())
    this.renderer.drawFrame(t, this.notes, hands, this.stats, this.flashes, this.bpm)

    const allDone = this.notes.every((n) => n.state !== 'pending')
    const audioEnded = this.audio.ended
    if (allDone || audioEnded) {
      this.playing = false
      this.onEnd()
      return
    }
    this.raf = requestAnimationFrame(this.loop)
  }
}
