import type { Slot, Vec } from './types.ts'

/**
 * Screen geometry shared by tracker, engine and renderer. The camera <video>
 * is shown mirrored with object-fit: cover, so landmarks must go through the
 * exact same transform to line up with what the player sees.
 */
export class View {
  w = 1
  h = 1
  private scale = 1
  private ox = 0
  private oy = 0
  private video: HTMLVideoElement

  constructor(video: HTMLVideoElement) {
    this.video = video
  }

  resize(w: number, h: number): void {
    this.w = w
    this.h = h
    this.updateCover()
  }

  updateCover(): void {
    const vw = this.video.videoWidth || 640
    const vh = this.video.videoHeight || 480
    this.scale = Math.max(this.w / vw, this.h / vh)
    this.ox = (this.w - vw * this.scale) / 2
    this.oy = (this.h - vh * this.scale) / 2
  }

  /** normalized camera coords → mirrored screen px */
  project = (nx: number, ny: number): Vec => {
    const vw = this.video.videoWidth || 640
    const vh = this.video.videoHeight || 480
    return {
      x: this.ox + (1 - nx) * vw * this.scale,
      y: this.oy + ny * vh * this.scale,
    }
  }

  get minDim(): number {
    return Math.min(this.w, this.h)
  }

  /** default body anchor if the player isn't detected yet */
  fallbackAnchor(): { anchor: Vec; shoulder: number } {
    return { anchor: { x: this.w / 2, y: this.h * 0.55 }, shoulder: this.minDim * 0.2 }
  }

  /** clamp a sane shoulder width so targets stay on screen and reachable */
  unit(shoulder: number): number {
    return Math.max(this.minDim * 0.1, Math.min(shoulder, this.minDim * 0.3))
  }

  /** body-space slot → screen position, kept inside the visible area */
  slotToScreen(slot: Slot, anchor: Vec, shoulder: number): Vec {
    const u = this.unit(shoulder)
    const r = this.saucerRadius(shoulder)
    const mx = r + 8
    const top = r + Math.min(70, this.h * 0.1) // keep clear of the HUD
    return {
      x: Math.max(mx, Math.min(this.w - mx, anchor.x + slot.x * u)),
      y: Math.max(top, Math.min(this.h - r - 8, anchor.y + slot.y * u)),
    }
  }

  saucerRadius(shoulder: number): number {
    return Math.max(26, Math.min(this.unit(shoulder) * 0.42, 95))
  }

  /** vanishing point of the flight track */
  vanish(): Vec {
    return { x: this.w / 2, y: this.h * 0.2 }
  }
}
