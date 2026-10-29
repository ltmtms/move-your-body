import type { BeatNote, Lane } from '../game/types.ts'

const MIN_BEAT_GAP_SEC = 0.22
const DEFAULT_BPM_FALLBACK = 120

function movingAverage(values: Float32Array, window: number): Float32Array {
  const out = new Float32Array(values.length)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    const denom = Math.min(i + 1, window)
    out[i] = sum / denom
  }
  return out
}

function pickPeaks(energy: Float32Array, hopSec: number): number[] {
  const smoothed = movingAverage(energy, 6)
  const peaks: number[] = []
  let lastPeakTime = -Infinity

  for (let i = 2; i < smoothed.length - 2; i++) {
    const e = smoothed[i]
    if (e <= smoothed[i - 1] || e <= smoothed[i + 1]) continue
    if (e <= smoothed[i - 2] || e <= smoothed[i + 2]) continue

    const localWindow = smoothed.slice(Math.max(0, i - 20), Math.min(smoothed.length, i + 20))
    let mean = 0
    for (const v of localWindow) mean += v
    mean /= localWindow.length || 1

    if (e < mean * 1.35) continue

    const t = i * hopSec
    if (t - lastPeakTime < MIN_BEAT_GAP_SEC) continue
    peaks.push(t)
    lastPeakTime = t
  }

  return peaks
}

function peaksFromConstantGrid(durationSec: number, bpm: number): number[] {
  const interval = 60 / bpm
  const peaks: number[] = []
  for (let t = interval; t < durationSec - 0.05; t += interval) {
    peaks.push(t)
  }
  return peaks
}

function assignLanes(beatTimes: number[]): BeatNote[] {
  const lanes: Lane[] = ['left', 'right']
  return beatTimes.map((hitTime, i) => ({
    id: i,
    hitTime,
    lane: lanes[i % 2],
    state: 'pending' as const,
  }))
}

/** Decode MP3/array buffer and build a playable beat grid from onset energy. */
export async function analyzeAudioFile(
  file: File,
): Promise<{ buffer: AudioBuffer; notes: BeatNote[]; bpmEstimate: number }> {
  const arrayBuffer = await file.arrayBuffer()
  const ctx = new AudioContext()
  const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))

  const channel = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const frameSize = 2048
  const hop = 512
  const hopSec = hop / sampleRate
  const frameCount = Math.floor((channel.length - frameSize) / hop)
  const energy = new Float32Array(frameCount)

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop
    let sum = 0
    let prev = channel[start]
    let flux = 0
    for (let i = 1; i < frameSize; i++) {
      const s = channel[start + i]
      const diff = s - prev
      if (diff > 0) flux += diff
      prev = s
      sum += s * s
    }
    energy[f] = Math.sqrt(sum / frameSize) + flux * 2
  }

  let beatTimes = pickPeaks(energy, hopSec)
  if (beatTimes.length < 8) {
    beatTimes = peaksFromConstantGrid(buffer.duration, DEFAULT_BPM_FALLBACK)
  }

  const intervals: number[] = []
  for (let i = 1; i < Math.min(beatTimes.length, 32); i++) {
    intervals.push(beatTimes[i] - beatTimes[i - 1])
  }
  intervals.sort((a, b) => a - b)
  const medianInterval =
    intervals.length > 0 ? intervals[Math.floor(intervals.length / 2)] : 60 / DEFAULT_BPM_FALLBACK
  const bpmEstimate = Math.round(60 / Math.max(medianInterval, 0.25))

  await ctx.close()

  return {
    buffer,
    notes: assignLanes(beatTimes),
    bpmEstimate: Math.min(Math.max(bpmEstimate, 80), 180),
  }
}
