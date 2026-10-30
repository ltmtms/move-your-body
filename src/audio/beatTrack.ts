import type { Chart, Difficulty, Note, Side, Slot } from '../game/types.ts'

/**
 * Offline music analysis, pure functions (runs inside a Web Worker).
 *
 * 1. STFT → log-magnitude spectral flux = onset strength envelope
 *    (full band + a low band for kick drums).
 * 2. Tempo: autocorrelation of the onset envelope, weighted towards ~120 BPM.
 * 3. Beats: dynamic-programming beat tracker (Ellis 2007) – picks the beat
 *    sequence that lands on strong onsets while keeping a steady tempo.
 * 4. Chart: beats (+ strong off-beats on harder levels) become saucers.
 */

export const ANALYSIS_RATE = 22050
const FRAME = 1024
const HOP = 256
export const HOP_SEC = HOP / ANALYSIS_RATE
/** envelope frame i describes the audio around its centre, not its start */
const CENTER = FRAME / 2 / ANALYSIS_RATE

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

export interface Envelope {
  onset: Float32Array
  low: Float32Array
  rms: Float32Array
}

export function onsetEnvelope(samples: Float32Array, progress?: (r: number) => void): Envelope {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP))
  const bins = FRAME / 2
  const lowBins = Math.ceil((180 / ANALYSIS_RATE) * FRAME)
  const win = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  const re = new Float32Array(FRAME)
  const im = new Float32Array(FRAME)
  let prev = new Float32Array(bins)
  let cur = new Float32Array(bins)
  const onset = new Float32Array(frames)
  const low = new Float32Array(frames)
  const rms = new Float32Array(frames)

  for (let f = 0; f < frames; f++) {
    const off = f * HOP
    let e = 0
    for (let i = 0; i < FRAME; i++) {
      const s = samples[off + i]
      e += s * s
      re[i] = s * win[i]
      im[i] = 0
    }
    rms[f] = Math.sqrt(e / FRAME)
    fft(re, im)
    let flux = 0
    let lowFlux = 0
    for (let k = 1; k < bins; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]))
      cur[k] = m
      const d = m - prev[k]
      if (d > 0) {
        flux += d
        if (k <= lowBins) lowFlux += d
      }
    }
    onset[f] = flux
    low[f] = lowFlux
    ;[prev, cur] = [cur, prev]
    if (progress && f % 2000 === 0) progress(f / frames)
  }
  return { onset: normalizeAdaptive(onset), low: normalizeAdaptive(low), rms }
}

/** Remove the local mean (≈0.5 s) and scale to unit std so peaks stand out. */
function normalizeAdaptive(x: Float32Array): Float32Array {
  const n = x.length
  const w = Math.round(0.5 / HOP_SEC)
  const out = new Float32Array(n)
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i]
  let sq = 0
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w)
    const b = Math.min(n, i + w + 1)
    const mean = (prefix[b] - prefix[a]) / (b - a)
    const v = Math.max(0, x[i] - mean)
    out[i] = v
    sq += v * v
  }
  const std = Math.sqrt(sq / Math.max(1, n)) || 1
  for (let i = 0; i < n; i++) out[i] /= std
  return out
}

export function estimateTempo(onset: Float32Array): number {
  const minLag = Math.floor(60 / 185 / HOP_SEC)
  const maxLag = Math.ceil(60 / 65 / HOP_SEC)
  const n = Math.min(onset.length, Math.round(120 / HOP_SEC)) // first 2 minutes
  const start = Math.min(Math.round(10 / HOP_SEC), Math.max(0, onset.length - n)) // skip intros
  const seg = onset.subarray(start, Math.min(onset.length, start + n))
  let bestLag = Math.round(60 / 120 / HOP_SEC)
  let best = -Infinity
  const ac = new Float32Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = lag; i < seg.length; i++) s += seg[i] * seg[i - lag]
    ac[lag] = s / (seg.length - lag)
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * HOP_SEC)
    // log-gaussian prior around 120 BPM, plus support from the double period
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    const dbl = 2 * lag <= maxLag ? ac[2 * lag] * 0.5 : 0
    const score = (ac[lag] + dbl) * prior
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  // parabolic refinement
  const a = ac[bestLag - 1] ?? 0
  const b = ac[bestLag]
  const c = ac[bestLag + 1] ?? 0
  const denom = a - 2 * b + c
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0
  return 60 / ((bestLag + shift) * HOP_SEC)
}

/** Ellis-style DP beat tracker. Returns beat times in seconds. */
export function trackBeats(onset: Float32Array, bpm: number, tightness = 100): number[] {
  const n = onset.length
  const period = 60 / bpm / HOP_SEC
  const score = new Float32Array(n)
  const back = new Int32Array(n).fill(-1)
  const lo = Math.round(period / 2)
  const hi = Math.round(period * 2)
  for (let i = 0; i < n; i++) {
    let best = 0
    let arg = -1
    for (let j = i - hi; j <= i - lo; j++) {
      if (j < 0) continue
      const r = Math.log((i - j) / period)
      const s = score[j] - tightness * r * r
      if (s > best || arg < 0) {
        best = s
        arg = j
      }
    }
    score[i] = onset[i] + (arg >= 0 ? Math.max(0, best) : 0)
    back[i] = best > 0 ? arg : -1
  }
  // start from the best-scoring frame in the last period
  let i = n - 1
  let top = -Infinity
  for (let k = Math.max(0, n - Math.round(period)); k < n; k++) {
    if (score[k] > top) {
      top = score[k]
      i = k
    }
  }
  const beats: number[] = []
  while (i >= 0) {
    beats.push(i * HOP_SEC + CENTER)
    i = back[i]
  }
  return beats.reverse()
}

function peakNear(env: Float32Array, t: number, radiusSec = 0.05): number {
  const c = Math.round((t - CENTER) / HOP_SEC)
  const r = Math.round(radiusSec / HOP_SEC)
  let m = 0
  for (let i = Math.max(0, c - r); i <= Math.min(env.length - 1, c + r); i++) m = Math.max(m, env[i])
  return m
}

function meanRange(x: Float32Array, a: number, b: number): number {
  const i0 = Math.max(0, Math.round((a - CENTER) / HOP_SEC))
  const i1 = Math.min(x.length, Math.max(i0 + 1, Math.round((b - CENTER) / HOP_SEC)))
  let s = 0
  for (let i = i0; i < i1; i++) s += x[i]
  return s / Math.max(1, i1 - i0)
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

/** Reachable target slots in body space (shoulder-width units, y down). */
const SLOTS: Record<Side, Slot[]> = {
  L: [
    { x: -1.45, y: -1.25 }, // high
    { x: -1.75, y: -0.35 }, // wide
    { x: -1.25, y: 0.55 }, // low
    { x: -0.7, y: -1.6 }, // over head
  ],
  R: [
    { x: 1.45, y: -1.25 },
    { x: 1.75, y: -0.35 },
    { x: 1.25, y: 0.55 },
    { x: 0.7, y: -1.6 },
  ],
}

const LEVEL = {
  easy: { minGap: 0.75, offbeats: false, doubles: 0.0, keep: 0.6 },
  normal: { minGap: 0.42, offbeats: false, doubles: 0.12, keep: 0.25 },
  hard: { minGap: 0.24, offbeats: true, doubles: 0.2, keep: 0.1 },
} as const

export function buildChart(
  env: Envelope,
  duration: number,
  difficulty: Difficulty,
  seed: number,
): Chart {
  let bpm = estimateTempo(env.onset)
  let beats = trackBeats(env.onset, bpm)
  if (beats.length < 8) {
    bpm = 120
    beats = []
    for (let t = 1; t < duration - 0.5; t += 0.5) beats.push(t)
  }
  // refine bpm from tracked beats (median interval)
  const iv = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b)
  if (iv.length) bpm = 60 / iv[Math.floor(iv.length / 2)]

  const cfg = LEVEL[difficulty]
  const rand = rng(seed)
  const loud = Array.from(env.rms).sort((a, b) => a - b)[Math.floor(env.rms.length * 0.95)] || 1

  type Cand = { t: number; strength: number; beatIndex: number; off: boolean }
  const cands: Cand[] = []
  beats.forEach((t, i) => {
    if (t < 1.2 || t > duration - 0.3) return
    const s = peakNear(env.onset, t) + 0.6 * peakNear(env.low, t)
    cands.push({ t, strength: s, beatIndex: i, off: false })
    if (cfg.offbeats && i + 1 < beats.length) {
      const mid = (t + beats[i + 1]) / 2
      const ms = peakNear(env.onset, mid, 0.03)
      if (ms > 1.8) cands.push({ t: mid, strength: ms * 0.8, beatIndex: i, off: true })
    }
  })

  // drop notes in quiet passages / weak beats, enforce minimum gap
  const strengths = cands.map((c) => c.strength).sort((a, b) => a - b)
  const weakCut = strengths[Math.floor(strengths.length * cfg.keep)] ?? 0
  const picked: Cand[] = []
  for (const c of cands) {
    const level = meanRange(env.rms, c.t - 0.2, c.t + 0.2) / loud
    if (level < 0.08) continue
    if (c.strength < weakCut && !(difficulty === 'easy' && c.beatIndex % 2 === 0 && c.strength > weakCut * 0.5)) continue
    const last = picked[picked.length - 1]
    if (last && c.t - last.t < cfg.minGap) {
      if (c.strength > last.strength * 1.4 && !last.off) picked[picked.length - 1] = c
      continue
    }
    picked.push(c)
  }

  // pattern generation: phrases of 4 notes flow around the body
  const notes: Note[] = []
  let id = 0
  let side: Side = 'L'
  let slotIdx = 0
  const strongCut = strengths[Math.floor(strengths.length * 0.85)] ?? Infinity
  picked.forEach((c, i) => {
    const prevT = i > 0 ? picked[i - 1].t : -10
    const gap = c.t - prevT
    if (i % 4 === 0) slotIdx = Math.floor(rand() * 4)
    // alternate hands when fast, sometimes repeat a hand when slow
    if (gap < 0.6 || rand() < 0.7) side = side === 'L' ? 'R' : 'L'
    // over-head slot only on slow gaps (it's a long reach)
    let s = (slotIdx + (i % 4)) % 4
    if (s === 3 && gap < 0.5) s = 0
    const group = id
    const isDouble = c.strength >= strongCut && rand() < cfg.doubles * 3 && gap > 0.5
    if (isDouble) {
      const ds = s === 3 ? 0 : s
      notes.push({ id: id++, time: c.t, side: 'L', slot: SLOTS.L[ds], group, strength: c.strength })
      notes.push({ id: id++, time: c.t, side: 'R', slot: SLOTS.R[ds], group, strength: c.strength })
    } else {
      notes.push({ id: id++, time: c.t, side, slot: SLOTS[side][s], group, strength: c.strength })
    }
  })

  return { bpm: Math.round(bpm * 10) / 10, duration, beats, notes }
}
