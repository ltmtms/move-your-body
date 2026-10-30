import { buildChart, onsetEnvelope } from './beatTrack.ts'
import type { Difficulty } from '../game/types.ts'

interface Req {
  samples: Float32Array
  duration: number
  difficulty: Difficulty
  seed: number
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { samples, duration, difficulty, seed } = e.data
  try {
    const env = onsetEnvelope(samples, (r) => self.postMessage({ type: 'progress', value: r * 0.9 }))
    const chart = buildChart(env, duration, difficulty, seed)
    self.postMessage({ type: 'done', chart })
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
