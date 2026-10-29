import * as tf from '@tensorflow/tfjs-core'
import '@tensorflow/tfjs-backend-webgl'
import type * as poseDetection from '@tensorflow-models/pose-detection'
import type { HandPositions } from '../game/types.ts'

export type PoseLoadProgress = (message: string, ratio: number) => void

export class PoseTracker {
  private detector: poseDetection.PoseDetector | null = null
  private video: HTMLVideoElement
  private running = false

  constructor(video: HTMLVideoElement) {
    this.video = video
  }

  async load(onProgress: PoseLoadProgress): Promise<void> {
    onProgress('Starting TensorFlow…', 0.05)
    await tf.setBackend('webgl')
    await tf.ready()
    onProgress('Loading MoveNet (lightning)…', 0.25)
    const poseDetection = await import('@tensorflow-models/pose-detection')
    this.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        enableSmoothing: true,
      },
    )
    onProgress('Pose model ready', 1)
  }

  start(): void {
    this.running = true
  }

  stop(): void {
    this.running = false
  }

  async estimateHands(): Promise<HandPositions> {
    const empty: HandPositions = { left: null, right: null }
    if (!this.running || !this.detector || this.video.readyState < 2) return empty

    const poses = await this.detector.estimatePoses(this.video, {
      maxPoses: 1,
      flipHorizontal: true,
    })
    const pose = poses[0]
    if (!pose) return empty

    const find = (name: string) =>
      pose.keypoints.find((k) => k.name === name && (k.score ?? 0) > 0.25)

    const lw = find('left_wrist')
    const rw = find('right_wrist')

    return {
      left: lw
        ? { x: lw.x / this.video.videoWidth, y: lw.y / this.video.videoHeight, score: lw.score ?? 0 }
        : null,
      right: rw
        ? { x: rw.x / this.video.videoWidth, y: rw.y / this.video.videoHeight, score: rw.score ?? 0 }
        : null,
    }
  }

  dispose(): void {
    this.detector?.dispose()
    this.detector = null
  }
}

export async function openFrontCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  })
  video.srcObject = stream
  video.playsInline = true
  video.muted = true
  await video.play()
  return stream
}
