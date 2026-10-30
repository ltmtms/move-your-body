import type { Chart, Difficulty } from '../game/types.ts'
import { ANALYSIS_RATE } from './beatTrack.ts'

let shared: AudioContext | null = null

/** Must be first called from a user gesture (iOS). */
export function audioContext(): AudioContext {
  if (!shared) shared = new AudioContext({ latencyHint: 'interactive' })
  if (shared.state === 'suspended') void shared.resume()
  return shared
}

export async function decodeFile(file: File): Promise<AudioBuffer> {
  const data = await file.arrayBuffer()
  return audioContext().decodeAudioData(data)
}

/** Mono, 22.05 kHz copy of the track for analysis. */
async function downmix(buffer: AudioBuffer): Promise<Float32Array> {
  const len = Math.ceil(buffer.duration * ANALYSIS_RATE)
  const off = new OfflineAudioContext(1, len, ANALYSIS_RATE)
  const src = off.createBufferSource()
  src.buffer = buffer
  src.connect(off.destination)
  src.start()
  const out = await off.startRendering()
  return out.getChannelData(0)
}

export async function analyze(
  buffer: AudioBuffer,
  difficulty: Difficulty,
  seed: number,
  onProgress: (r: number) => void,
): Promise<Chart> {
  const samples = await downmix(buffer)
  const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<Chart>((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data
        if (m.type === 'progress') onProgress(m.value)
        else if (m.type === 'done') resolve(m.chart)
        else reject(new Error(m.message))
      }
      worker.onerror = (e) => reject(new Error(e.message || 'analysis worker failed'))
      worker.postMessage({ samples, duration: buffer.duration, difficulty, seed }, [samples.buffer])
    })
  } finally {
    worker.terminate()
  }
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Plays the track and exposes a sample-accurate song clock that can also map
 * any performance.now() timestamp (e.g. a camera frame) onto song time.
 */
export class SongPlayer {
  private ctx = audioContext()
  private src: AudioBufferSourceNode | null = null
  private startCtx = 0
  private pausedAt = 0
  private gain: GainNode
  playing = false
  ended = false

  private buffer: AudioBuffer

  constructor(buffer: AudioBuffer) {
    this.buffer = buffer
    this.gain = this.ctx.createGain()
    this.gain.gain.value = 0.9
    this.gain.connect(this.ctx.destination)
  }

  /** start so that song time 0 happens `delay` seconds from now */
  play(delay = 0, from = this.pausedAt): void {
    this.src = this.ctx.createBufferSource()
    this.src.buffer = this.buffer
    this.src.connect(this.gain)
    const when = this.ctx.currentTime + delay
    // negative offsets (lead-in) are handled by delaying the start
    this.src.start(when + Math.max(0, -from), Math.max(0, from))
    this.startCtx = when - from
    this.playing = true
    this.src.onended = () => {
      if (this.playing && this.time() >= this.buffer.duration - 0.05) {
        this.ended = true
        this.playing = false
      }
    }
  }

  pause(): void {
    if (!this.playing) return
    this.pausedAt = this.time()
    this.playing = false
    this.src?.stop()
    this.src = null
  }

  resume(): void {
    if (this.playing) return
    this.play(0.05, this.pausedAt - 1.5) // 1.5 s rewind to re-catch the beat
  }

  stop(): void {
    this.playing = false
    try {
      this.src?.stop()
    } catch {
      /* already stopped */
    }
    this.src = null
  }

  /** song time at a performance.now() timestamp, compensating output latency */
  timeAt(perfMs: number): number {
    if (!this.playing) return this.pausedAt
    const ts = this.ctx.getOutputTimestamp?.()
    let ctxTime: number
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      ctxTime = ts.contextTime + (perfMs - ts.performanceTime) / 1000
    } else {
      ctxTime = this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0) + (perfMs - performance.now()) / 1000
    }
    return ctxTime - this.startCtx
  }

  time(): number {
    return this.timeAt(performance.now())
  }

  get duration(): number {
    return this.buffer.duration
  }
}

/** Miss and count-in sounds (hit sounds live in kits.ts). */
export class Sfx {
  private ctx = audioContext()

  miss(): void {
    const t = this.ctx.currentTime
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(180, t)
    o.frequency.exponentialRampToValueAtTime(60, t + 0.18)
    g.gain.setValueAtTime(0.05, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
    o.connect(g).connect(this.ctx.destination)
    o.start(t)
    o.stop(t + 0.21)
  }

  tick(high = false): void {
    const t = this.ctx.currentTime
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.frequency.value = high ? 1760 : 880
    g.gain.setValueAtTime(0.12, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15)
    o.connect(g).connect(this.ctx.destination)
    o.start(t)
    o.stop(t + 0.16)
  }
}

/** A built-in 128 BPM techno loop so the game can be tried without an MP3. */
export async function renderDemoTrack(seconds = 75): Promise<AudioBuffer> {
  const rate = 44100
  const bpm = 128
  const beat = 60 / bpm
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate)
  const master = ctx.createGain()
  master.gain.value = 0.7
  master.connect(ctx.destination)

  const noise = ctx.createBuffer(1, rate, rate)
  const nd = noise.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1

  const bassNotes = [41.2, 41.2, 49.0, 36.7]
  const totalBeats = Math.floor((seconds - 1) / beat)
  for (let b = 0; b < totalBeats; b++) {
    const t = 0.5 + b * beat
    const bar = Math.floor(b / 4)
    const intro = bar < 4
    const breakdown = bar >= 20 && bar < 24
    // kick
    if (!breakdown) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.setValueAtTime(150, t)
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12)
      g.gain.setValueAtTime(1, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
      o.connect(g).connect(master)
      o.start(t)
      o.stop(t + 0.36)
    }
    // off-beat open hat
    if (!intro) {
      const s = ctx.createBufferSource()
      s.buffer = noise
      const f = ctx.createBiquadFilter()
      f.type = 'highpass'
      f.frequency.value = 7000
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.25, t + beat / 2)
      g.gain.exponentialRampToValueAtTime(0.001, t + beat / 2 + 0.12)
      s.connect(f).connect(g).connect(master)
      s.start(t + beat / 2, Math.random() * 0.5, 0.13)
    }
    // clap on 2 and 4
    if (!intro && b % 2 === 1) {
      const s = ctx.createBufferSource()
      s.buffer = noise
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 1500
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.5, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
      s.connect(f).connect(g).connect(master)
      s.start(t, Math.random() * 0.5, 0.2)
    }
    // rolling bass on 16ths after the kick
    if (bar >= 8) {
      for (const k of [1, 2, 3]) {
        const tt = t + (k * beat) / 4
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        o.frequency.value = bassNotes[bar % 4] * 2
        const f = ctx.createBiquadFilter()
        f.type = 'lowpass'
        f.frequency.setValueAtTime(900, tt)
        f.frequency.exponentialRampToValueAtTime(120, tt + 0.1)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.18, tt)
        g.gain.exponentialRampToValueAtTime(0.001, tt + 0.12)
        o.connect(f).connect(g).connect(master)
        o.start(tt)
        o.stop(tt + 0.13)
      }
    }
    // stab chord every bar in the breakdown and drop
    if ((breakdown || bar >= 24) && b % 4 === 0) {
      for (const fr of [220, 261.6, 329.6]) {
        const o = ctx.createOscillator()
        o.type = 'square'
        o.frequency.value = fr
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.05, t)
        g.gain.exponentialRampToValueAtTime(0.001, t + beat * 1.5)
        o.connect(g).connect(master)
        o.start(t)
        o.stop(t + beat * 1.6)
      }
    }
  }
  return ctx.startRendering()
}
