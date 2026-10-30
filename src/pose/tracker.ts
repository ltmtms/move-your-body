import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { BodyFrame, PalmSample, Side, Vec } from '../game/types.ts'
import { OneEuro } from './oneEuro.ts'

/**
 * Upper-body tracking with MediaPipe PoseLandmarker (lite).
 *
 * Why pose instead of a hand model: hand detectors lose the hand as soon as it
 * motion-blurs during a fast slap, and they struggle when the player stands
 * 2 m away. The pose model tracks the whole arm chain (shoulder → elbow →
 * wrist → index/pinky knuckles) so the palm stays locked even when blurry,
 * and one model gives us shoulders as a body anchor for target placement.
 */

const L = { shoulder: 11, elbow: 13, wrist: 15, pinky: 17, index: 19 }
const R = { shoulder: 12, elbow: 14, wrist: 16, pinky: 18, index: 20 }
/** edges between BodyFrame.joints: [nose, lShoulder, rShoulder, lElbow, rElbow, lWrist, rWrist, lPalm, rPalm] */
export const SKELETON_EDGES: [number, number][] = [
  [1, 2], // shoulders
  [1, 3],
  [3, 5],
  [5, 7],
  [2, 4],
  [4, 6],
  [6, 8],
]

const BASE = import.meta.env.BASE_URL

export type Projector = (nx: number, ny: number) => Vec

interface PalmState {
  fx: OneEuro
  fy: OneEuro
  last: PalmSample | null
  lostAt: number
}

export class PoseTracker {
  private landmarker: PoseLandmarker | null = null
  private video: HTMLVideoElement
  private project: Projector
  private running = false
  private lastTs = 0
  private rafId = 0
  private palms: Record<Side, PalmState> = {
    L: { fx: new OneEuro(), fy: new OneEuro(), last: null, lostAt: 0 },
    R: { fx: new OneEuro(), fy: new OneEuro(), last: null, lostAt: 0 },
  }
  private anchor: Vec | null = null
  private shoulder = 0
  /** average ms between processed camera frames */
  frameInterval = 33
  onFrame: ((f: BodyFrame) => void) | null = null
  latest: BodyFrame | null = null

  constructor(video: HTMLVideoElement, project: Projector) {
    this.video = video
    this.project = project
  }

  async load(onStatus: (msg: string) => void): Promise<void> {
    onStatus('LOADING VISION RUNTIME')
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe`)
    const make = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_lite.task`, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      })
    onStatus('LOADING POSE MODEL')
    try {
      this.landmarker = await make('GPU')
    } catch (err) {
      console.warn('GPU delegate failed, falling back to CPU', err)
      this.landmarker = await make('CPU')
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule()
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
  }

  dispose(): void {
    this.stop()
    this.landmarker?.close()
    this.landmarker = null
  }

  private schedule(): void {
    if (!this.running) return
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number; presentationTime?: number }) => void) => number
    }
    // one inference per *new* camera frame; captureTime lets us time-stamp
    // the pose to the moment the photons hit the sensor
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback((now, meta) => {
        this.process(meta.captureTime ?? meta.presentationTime ?? now)
        this.schedule()
      })
    } else {
      this.rafId = requestAnimationFrame((now) => {
        this.process(now)
        this.schedule()
      })
    }
  }

  private process(frameTime: number): void {
    if (!this.landmarker || this.video.readyState < 2) return
    const now = performance.now()
    const ts = Math.max(now, this.lastTs + 1)
    let result
    try {
      result = this.landmarker.detectForVideo(this.video, ts)
    } catch (err) {
      console.warn(err)
      return
    }
    if (this.lastTs) this.frameInterval += (Math.min(200, ts - this.lastTs) - this.frameInterval) * 0.1
    this.lastTs = ts
    // never trust a capture time from the future or > 150 ms stale
    const t = Math.min(now, Math.max(frameTime, now - 150))
    const lm = result.landmarks[0]
    this.latest = this.toFrame(lm, t)
    this.onFrame?.(this.latest)
  }

  private toFrame(lm: NormalizedLandmark[] | undefined, t: number): BodyFrame {
    const pt = (i: number, minVis = 0.35): Vec | null => {
      const p = lm?.[i]
      if (!p || (p.visibility ?? 1) < minVis) return null
      return this.project(p.x, p.y)
    }

    const ls = pt(L.shoulder, 0.5)
    const rs = pt(R.shoulder, 0.5)
    if (ls && rs) {
      const mid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 }
      const w = Math.hypot(ls.x - rs.x, ls.y - rs.y)
      const k = this.anchor ? 0.08 : 1
      this.anchor = this.anchor
        ? { x: this.anchor.x + (mid.x - this.anchor.x) * k, y: this.anchor.y + (mid.y - this.anchor.y) * k }
        : mid
      // turning sideways shrinks the shoulder line; only let it shrink slowly
      const target = this.shoulder ? Math.max(w, this.shoulder * 0.85) : w
      this.shoulder = this.shoulder ? this.shoulder + (target - this.shoulder) * k : w
    }

    const palms: Record<Side, PalmSample | null> = {
      L: this.palm('L', L, lm, t),
      R: this.palm('R', R, lm, t),
    }
    const joints = [
      pt(0),
      ls,
      rs,
      pt(L.elbow),
      pt(R.elbow),
      pt(L.wrist),
      pt(R.wrist),
      palms.L,
      palms.R,
    ]
    return { t, anchor: this.anchor, shoulder: this.shoulder, palms, joints }
  }

  /**
   * Palm centre = weighted mix of wrist and the index/pinky knuckles,
   * filtered with One Euro. If the hand blurs out mid-swing we dead-reckon
   * along the last velocity for a few frames so the swipe still connects.
   */
  private palm(side: Side, ids: typeof L, lm: NormalizedLandmark[] | undefined, t: number): PalmSample | null {
    const st = this.palms[side]
    const w = lm?.[ids.wrist]
    const i = lm?.[ids.index]
    const p = lm?.[ids.pinky]
    const vis = Math.min(w?.visibility ?? 0, Math.max(i?.visibility ?? 0, p?.visibility ?? 0))
    const last = st.last
    const dt = last ? Math.max(0.001, (t - last.t) / 1000) : 0

    if (!w || vis < 0.3) {
      if (!last) return null
      const since = t - (st.lostAt || t)
      if (!st.lostAt) st.lostAt = t
      const speed = Math.hypot(last.vx, last.vy)
      if (since < 140 && speed > 400) {
        const decay = 0.6
        const s: PalmSample = {
          x: last.x + last.vx * dt * decay,
          y: last.y + last.vy * dt * decay,
          vx: last.vx * decay,
          vy: last.vy * decay,
          t,
          predicted: true,
        }
        st.last = s
        return s
      }
      st.last = null
      st.fx.reset()
      st.fy.reset()
      return null
    }
    st.lostAt = 0

    let nx = w.x
    let ny = w.y
    if (i && p) {
      nx = w.x * 0.3 + i.x * 0.35 + p.x * 0.35
      ny = w.y * 0.3 + i.y * 0.35 + p.y * 0.35
    }
    const raw = this.project(nx, ny)
    const x = st.fx.filter(raw.x, dt)
    const y = st.fy.filter(raw.y, dt)
    let vx = 0
    let vy = 0
    if (last && dt > 0) {
      vx = (x - last.x) / dt
      vy = (y - last.y) / dt
      // light smoothing so a single noisy frame doesn't fake a slap
      vx = last.vx * 0.3 + vx * 0.7
      vy = last.vy * 0.3 + vy * 0.7
    }
    const s: PalmSample = { x, y, vx, vy, t, predicted: false }
    st.last = s
    return s
  }
}

export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 60, max: 60 },
    },
  })
  video.srcObject = stream
  video.playsInline = true
  video.muted = true
  await video.play()
  return stream
}
