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
  /** per frame: 12 chroma + 12 bass chroma + 6 timbre bands (frames × NB) */
  bands: Float32Array
}

/** 12 pitch classes (harmony) + 12 bass pitch classes + 6 log-spaced energy bands (timbre) */
export const NB = 30
const BASS = 12
const TIMBRE = 24

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
  const bands = new Float32Array(frames * NB)
  // bin → chroma class (bass 50–200 Hz, harmony 200 Hz–5 kHz) and timbre band (60 Hz–11 kHz, log spaced)
  const chroma = new Int8Array(bins).fill(-1)
  const timbre = new Int8Array(bins).fill(-1)
  for (let k = 1; k < bins; k++) {
    const hz = (k * ANALYSIS_RATE) / FRAME
    const pc = ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12
    if (hz >= 200 && hz <= 5000) chroma[k] = pc
    else if (hz >= 50 && hz < 200) chroma[k] = BASS + pc
    if (hz >= 60) timbre[k] = Math.min(5, Math.floor(Math.log2(hz / 60) / (Math.log2(11000 / 60) / 6)))
  }

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
      if (chroma[k] >= 0) bands[f * NB + chroma[k]] += m
      if (timbre[k] >= 0) bands[f * NB + TIMBRE + timbre[k]] += m
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
  return { onset: normalizeAdaptive(onset), low: normalizeAdaptive(low), rms, bands }
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

// ───────────────────────── musical structure ─────────────────────────

export interface BeatInfo {
  t: number
  /** position in the bar: 0 = downbeat (重拍) … 3 */
  pos: number
  bar: number
}

function frameAt(t: number, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.round((t - CENTER) / HOP_SEC)))
}

/** mean chroma/timbre vector of the audio between two times */
function meanBands(env: Envelope, a: number, b: number): Float32Array {
  const n = env.rms.length
  const i0 = frameAt(a, n)
  const i1 = Math.max(i0 + 1, frameAt(b, n))
  const v = new Float32Array(NB)
  for (let i = i0; i < i1; i++) for (let k = 0; k < NB; k++) v[k] += env.bands[i * NB + k]
  for (let k = 0; k < NB; k++) v[k] /= i1 - i0
  return v
}

function cosDist(a: Float32Array, b: Float32Array, from = 0, to = NB): number {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let k = from; k < to; k++) {
    ab += a[k] * b[k]
    aa += a[k] * a[k]
    bb += b[k] * b[k]
  }
  return aa && bb ? 1 - ab / Math.sqrt(aa * bb) : 0
}

function avgVec(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(NB)
  for (const v of vs) for (let k = 0; k < NB; k++) out[k] += v[k] / vs.length
  return out
}

function zscore(x: number[]): number[] {
  const m = x.reduce((a, b) => a + b, 0) / Math.max(1, x.length)
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, x.length)) || 1
  return x.map((v) => (v - m) / sd)
}

/**
 * Downbeat (重拍) detection. A bar usually starts where the kick/bass is
 * strongest and where the harmony and timbre change. Each beat gets a score
 * from those cues, then the 4-beat phase with the highest average score in a
 * sliding ±4-bar window wins, so one skipped beat only shifts bars locally.
 */
export function findDownbeats(env: Envelope, beats: number[]): BeatInfo[] {
  const n = beats.length
  if (n === 0) return []
  const period = n > 1 ? (beats[n - 1] - beats[0]) / (n - 1) : 0.5
  const feat = beats.map((t, i) => meanBands(env, t, beats[i + 1] ?? t + period))
  // harmony from the sustained part of each beat (skip the drum transient),
  // minus the flat floor that noisy drums add to every pitch class
  const harm = beats.map((t, i) => {
    const end = beats[i + 1] ?? t + period
    const v = meanBands(env, t + 0.3 * (end - t), end)
    for (const [a, b] of [[0, 12], [BASS, BASS + 12]]) {
      const floor = Math.min(...v.subarray(a, b))
      for (let k = a; k < b; k++) v[k] -= floor
    }
    return v
  })
  const kick = zscore(beats.map((t) => peakNear(env.low, t, 0.04)))
  const hit = zscore(beats.map((t) => peakNear(env.onset, t, 0.04)))
  const chord = zscore(beats.map((_, i) => (i ? cosDist(harm[i], harm[i - 1], 0, 12) : 0)))
  const bass = zscore(beats.map((_, i) => (i ? cosDist(harm[i], harm[i - 1], BASS, BASS + 12) : 0)))
  // backbeat: snares/claps (bright hits without kick) land on beats 2 and 4,
  // so a downbeat is followed by one a beat later and three beats later
  const snare = zscore(beats.map((_, i) => hit[i] - kick[i]))
  const back = beats.map((_, i) => (snare[i + 1] ?? 0) + (snare[i + 3] ?? 0) - snare[i] - (snare[i + 2] ?? 0))
  // wider context: do the 2 beats from here sound different from the 2 before?
  const ctx = zscore(
    beats.map((_, i) =>
      i >= 2 && i + 2 <= n ? cosDist(avgVec(feat.slice(i, i + 2)), avgVec(feat.slice(i - 2, i))) : 0,
    ),
  )
  const score = beats.map((_, i) => kick[i] + 1.2 * chord[i] + 1.0 * bass[i] + 0.8 * ctx[i] + 0.6 * back[i])

  const phase = new Int8Array(n)
  let cur = -1
  for (let b0 = 0; b0 < n; b0 += 8) {
    const sum = [0, 0, 0, 0]
    const cnt = [0, 0, 0, 0]
    for (let j = Math.max(0, b0 - 16); j < Math.min(n, b0 + 24); j++) {
      sum[j % 4] += score[j]
      cnt[j % 4]++
    }
    const mean = sum.map((s, p) => s / Math.max(1, cnt[p]))
    let best = mean.indexOf(Math.max(...mean))
    if (cur >= 0 && mean[best] - mean[cur] < 0.25) best = cur // hysteresis: don't flicker
    cur = best
    for (let j = b0; j < Math.min(n, b0 + 8); j++) phase[j] = cur
  }

  const out: BeatInfo[] = []
  let bar = -1
  let prev = 4
  beats.forEach((t, i) => {
    const pos = (((i - phase[i]) % 4) + 4) % 4
    if (pos <= prev) bar++
    prev = pos
    out.push({ t, pos, bar })
  })
  return out
}

/**
 * Split the song into ≤ 4 sections (intro / verse / drop …) at phrase
 * boundaries where loudness or timbre changes the most. Each section gets its
 * own percussion kit, so the hit sound switches at most 3 times.
 */
export function findSections(env: Envelope, info: BeatInfo[], loud: number, maxSections = 4): number[] {
  const bars: { t0: number; t1: number }[] = []
  for (let i = 0; i < info.length; i++) {
    if (info[i].pos !== 0) continue
    const next = info.findIndex((b, j) => j > i && b.pos === 0)
    bars.push({ t0: info[i].t, t1: next > 0 ? info[next].t : info[info.length - 1].t })
  }
  const nb = bars.length
  if (nb < 16) return [0]
  const energy = bars.map((b) => meanRange(env.rms, b.t0, b.t1) / loud)
  const feat = bars.map((b) => meanBands(env, b.t0, b.t1))
  const minLen = Math.max(6, Math.round(nb * 0.08))
  const cands: { b: number; nov: number }[] = []
  for (let b = 4; b <= nb - 4; b += 4) {
    const after = energy.slice(b, b + 4).reduce((x, y) => x + y, 0) / 4
    const before = energy.slice(b - 4, b).reduce((x, y) => x + y, 0) / 4
    const nov = Math.abs(after - before) + 2 * cosDist(avgVec(feat.slice(b, b + 4)), avgVec(feat.slice(b - 4, b)))
    cands.push({ b, nov })
  }
  const novs = cands.map((c) => c.nov)
  const thresh = novs.reduce((a, b) => a + b, 0) / Math.max(1, novs.length) + 0.5 * Math.sqrt(
    novs.reduce((a, v) => a + (v - novs.reduce((x, y) => x + y, 0) / novs.length) ** 2, 0) / Math.max(1, novs.length),
  )
  const chosen: number[] = []
  for (const c of [...cands].sort((a, b) => b.nov - a.nov)) {
    if (chosen.length >= maxSections - 1 || c.nov < thresh) break
    if (c.b < minLen || nb - c.b < minLen) continue
    if (chosen.some((b) => Math.abs(b - c.b) < minLen)) continue
    chosen.push(c.b)
  }
  return [0, ...chosen.sort((a, b) => a - b).map((b) => bars[b].t0)]
}

/** if the low end hits harder half-way between our beats, we locked onto the off-beat */
function fixHalfBeat(env: Envelope, beats: number[]): number[] {
  if (beats.length < 8) return beats
  let on = 0
  let off = 0
  for (let i = 0; i + 1 < beats.length; i++) {
    on += peakNear(env.low, beats[i], 0.03)
    off += peakNear(env.low, (beats[i] + beats[i + 1]) / 2, 0.03)
  }
  if (off <= on * 1.15) return beats
  return beats.slice(0, -1).map((b, i) => (b + beats[i + 1]) / 2)
}

// ───────────────────────── chart ─────────────────────────

/** EASY & NORMAL: always the same two targets, one per hand */
const FIXED: Record<Side, Slot> = { L: { x: -1.5, y: -0.8 }, R: { x: 1.5, y: -0.8 } }

/** HARD: targets move around the body (shoulder-width units, y down) */
const HARD_SLOTS: Record<Side, Slot[]> = {
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

const MIN_GAP: Record<Difficulty, number> = { easy: 0.9, normal: 0.4, hard: 0.22 }

export function analyzeRhythm(env: Envelope, duration: number): { bpm: number; beats: number[]; info: BeatInfo[] } {
  // beats are carried by kick & bass: weight the low band so off-beat hi-hats
  // (every techno track has them) can't pull the tracker half a beat off
  const pulse = new Float32Array(env.onset.length)
  for (let i = 0; i < pulse.length; i++) pulse[i] = env.onset[i] + 1.5 * env.low[i]
  let bpm = estimateTempo(pulse)
  let beats = trackBeats(pulse, bpm)
  beats = fixHalfBeat(env, beats)
  if (beats.length < 8) {
    bpm = 120
    beats = []
    for (let t = 1; t < duration - 0.5; t += 0.5) beats.push(t)
  }
  const iv = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b)
  if (iv.length) bpm = 60 / iv[Math.floor(iv.length / 2)]
  return { bpm, beats, info: findDownbeats(env, beats) }
}

export function buildChart(env: Envelope, duration: number, difficulty: Difficulty, seed: number): Chart {
  const { bpm, beats, info } = analyzeRhythm(env, duration)
  const period = 60 / bpm

  const rand = rng(seed)
  const loud = Array.from(env.rms).sort((a, b) => a - b)[Math.floor(env.rms.length * 0.95)] || 1
  const starts = findSections(env, info, loud)
  const kit0 = seed % 4
  const sections = starts.map((start, i) => ({ start, kit: (kit0 + i) % 4 }))
  const kitAt = (t: number) => {
    let k = sections[0].kit
    for (const s of sections) if (s.start <= t + 0.05) k = s.kit
    return k
  }

  // bar loudness (0–1) so quiet intros/breaks get fewer saucers
  const barLevel = new Map<number, number>()
  info.forEach((b, i) => {
    if (barLevel.has(b.bar)) return
    let j = i
    while (j + 1 < info.length && info[j + 1].bar === b.bar) j++
    const end = info[j + 1]?.t ?? info[j].t + period
    barLevel.set(b.bar, meanRange(env.rms, b.t, end))
  })
  // relative to the song's loud bars (90th percentile) so 1 ≈ the drop
  const levels = [...barLevel.values()].sort((a, b) => a - b)
  const loudBar = levels[Math.floor(levels.length * 0.9)] || 1
  for (const [k, v] of barLevel) barLevel.set(k, v / loudBar)

  const notes: Note[] = []
  let id = 0
  let lastT = -10
  let side: Side = rand() < 0.5 ? 'L' : 'R'
  let shape = 0
  let offbeatBar = -1
  const flip = (s: Side): Side => (s === 'L' ? 'R' : 'L')

  const place = (t: number, beat: number, strength: number, double: boolean, slotIdx: number) => {
    if (t - lastT < MIN_GAP[difficulty]) return
    const gap = t - lastT
    lastT = t
    const kit = kitAt(t)
    const slotFor = (s: Side) => {
      if (difficulty !== 'hard') return FIXED[s]
      // the over-head reach needs time
      const k = slotIdx === 3 && gap < 0.45 ? 0 : slotIdx
      return HARD_SLOTS[s][k]
    }
    const group = id
    if (double) {
      for (const s of ['L', 'R'] as Side[])
        notes.push({ id: id++, time: t, side: s, slot: slotFor(s), group, strength, beat, kit })
      return
    }
    // alternate hands; on HARD a slow gap sometimes keeps the same hand
    if (!(difficulty === 'hard' && gap > 0.6 && rand() < 0.3)) side = flip(side)
    notes.push({ id: id++, time: t, side, slot: slotFor(side), group, strength, beat, kit })
  }

  info.forEach((b, i) => {
    if (b.t < 1.0 || b.t > duration - 0.3) return
    const level = barLevel.get(b.bar) ?? 0
    if (level < 0.12) return // silence / fade
    const strength = peakNear(env.onset, b.t) + 0.6 * peakNear(env.low, b.t)
    const newSection = sections.some((s, k) => k > 0 && Math.abs(s.start - b.t) < period / 2)
    if (b.pos === 0) shape = Math.floor(rand() * 4)

    if (difficulty === 'easy') {
      // downbeats only; at very fast tempos every other bar
      if (b.pos !== 0 || (period * 4 < 1.3 && b.bar % 2 === 1)) return
      place(b.t, 0, strength, newSection, 0)
    } else if (difficulty === 'normal') {
      // beats 1 and 3 of each bar
      if (b.pos !== 0 && b.pos !== 2) return
      const double = b.pos === 0 && (newSection || (level > 0.7 && b.bar % 8 === 0))
      place(b.t, b.pos, strength, double, 0)
    } else {
      // every beat in busy bars, 1 & 3 in quiet ones, plus strong off-beats
      if (level < 0.3 && b.pos % 2 === 1) return
      const double = b.pos === 0 && (newSection || (level > 0.55 && b.bar % 4 === 0))
      place(b.t, b.pos, strength, double, (shape + b.pos) % 4)
      // at most one syncopated off-beat per loud bar ("2-and" or "4-and")
      const next = info[i + 1]
      if (next && level > 0.6 && b.pos % 2 === 1 && offbeatBar !== b.bar) {
        const mid = (b.t + next.t) / 2
        if (peakNear(env.onset, mid, 0.03) > 1.8) {
          offbeatBar = b.bar
          place(mid, -1, strength * 0.8, false, (shape + b.pos + 2) % 4)
        }
      }
    }
  })

  return {
    bpm: Math.round(bpm * 10) / 10,
    duration,
    beats,
    downbeats: info.filter((b) => b.pos === 0).map((b) => b.t),
    sections,
    notes,
  }
}
