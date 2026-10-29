import type { BeatNote, GameStats, HandPositions, JudgmentFlash, Lane } from './types.ts'

const LEAD_SEC = 2.4
const COLORS: Record<Lane, { core: string; glow: string }> = {
  left: { core: '#00f5ff', glow: 'rgba(0,245,255,0.55)' },
  right: { core: '#ff00e5', glow: 'rgba(255,0,229,0.55)' },
}

export class GameRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private video: HTMLVideoElement
  private w = 0
  private h = 0

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.video = video
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const rect = this.canvas.getBoundingClientRect()
    this.w = rect.width
    this.h = rect.height
    this.canvas.width = Math.floor(rect.width * dpr)
    this.canvas.height = Math.floor(rect.height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  laneX(lane: Lane): number {
    return lane === 'left' ? this.w * 0.28 : this.w * 0.72
  }

  hitZoneY(): number {
    return this.h * 0.72
  }

  drawFrame(
    songTime: number,
    notes: BeatNote[],
    hands: HandPositions,
    stats: GameStats,
    flashes: JudgmentFlash[],
    bpm: number,
  ): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.w, this.h)

    this.drawCamera()
    this.drawGrid()
    this.drawRoad()
    this.drawHitZone()

    for (const note of notes) {
      if (note.state !== 'pending') continue
      const dt = note.hitTime - songTime
      if (dt < -0.35 || dt > LEAD_SEC) continue
      const progress = 1 - dt / LEAD_SEC
      this.drawDisk(note.lane, progress, note.state === 'pending')
    }

    this.drawHands(hands)
    this.drawHud(stats, bpm, songTime)
    this.drawFlashes(flashes)
    this.drawScanlines()
  }

  private drawCamera(): void {
    const ctx = this.ctx
    if (this.video.readyState >= 2) {
      ctx.save()
      ctx.globalAlpha = 0.35
      ctx.filter = 'saturate(1.4) contrast(1.1)'
      ctx.drawImage(this.video, 0, 0, this.w, this.h)
      ctx.restore()
    } else {
      ctx.fillStyle = '#050010'
      ctx.fillRect(0, 0, this.w, this.h)
    }
    const grad = ctx.createLinearGradient(0, 0, 0, this.h)
    grad.addColorStop(0, 'rgba(5,0,16,0.55)')
    grad.addColorStop(0.5, 'rgba(5,0,16,0.15)')
    grad.addColorStop(1, 'rgba(5,0,16,0.75)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, this.w, this.h)
  }

  private drawGrid(): void {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = 'rgba(0,255,255,0.08)'
    ctx.lineWidth = 1
    const spacing = 48
    for (let x = 0; x < this.w; x += spacing) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, this.h)
      ctx.stroke()
    }
    for (let y = 0; y < this.h; y += spacing) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(this.w, y)
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawRoad(): void {
    const ctx = this.ctx
    const topY = this.h * 0.08
    const bottomY = this.h * 0.95
    const cx = this.w / 2
    ctx.save()
    ctx.strokeStyle = 'rgba(180,0,255,0.35)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx - this.w * 0.05, topY)
    ctx.lineTo(cx - this.w * 0.38, bottomY)
    ctx.moveTo(cx + this.w * 0.05, topY)
    ctx.lineTo(cx + this.w * 0.38, bottomY)
    ctx.stroke()
    ctx.restore()
  }

  private drawHitZone(): void {
    const ctx = this.ctx
    const y = this.hitZoneY()
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.setLineDash([8, 10])
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(this.w * 0.12, y)
    ctx.lineTo(this.w * 0.88, y)
    ctx.stroke()
    ctx.setLineDash([])
    for (const lane of ['left', 'right'] as Lane[]) {
      const x = this.laneX(lane)
      const g = ctx.createRadialGradient(x, y, 4, x, y, 52)
      g.addColorStop(0, COLORS[lane].glow)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, 52, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  private drawDisk(lane: Lane, progress: number, active: boolean): void {
    const ctx = this.ctx
    const x = this.laneX(lane)
    const startY = this.h * 0.12
    const endY = this.hitZoneY()
    const y = startY + (endY - startY) * progress
    const scale = 0.15 + progress * 0.85
    const radius = 28 * scale
    const { core, glow } = COLORS[lane]

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const g = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius * 2.2)
    g.addColorStop(0, glow)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = core
    ctx.lineWidth = 3
    ctx.shadowColor = core
    ctx.shadowBlur = active ? 22 : 8
    ctx.beginPath()
    ctx.ellipse(x, y, radius, radius * 0.35, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.ellipse(x, y, radius * 0.55, radius * 0.18, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  private drawHands(hands: HandPositions): void {
    const ctx = this.ctx
    const drawWrist = (pt: { x: number; y: number } | null, color: string) => {
      if (!pt) return
      const x = pt.x * this.w
      const y = pt.y * this.h
      ctx.save()
      ctx.fillStyle = color
      ctx.shadowColor = color
      ctx.shadowBlur = 16
      ctx.beginPath()
      ctx.arc(x, y, 14, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    drawWrist(hands.left, '#00f5ff')
    drawWrist(hands.right, '#ff00e5')
  }

  private drawHud(stats: GameStats, bpm: number, songTime: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.font = '700 28px Orbitron, system-ui, sans-serif'
    ctx.fillStyle = '#00f5ff'
    ctx.shadowColor = '#00f5ff'
    ctx.shadowBlur = 12
    ctx.fillText(String(stats.score).padStart(6, '0'), 16, 40)

    ctx.font = '600 16px Orbitron, system-ui, sans-serif'
    ctx.fillStyle = '#ff00e5'
    ctx.fillText(`COMBO ${stats.combo}`, 16, 68)
    ctx.fillStyle = 'rgba(255,255,255,0.65)'
    ctx.fillText(`${bpm} BPM · ${songTime.toFixed(1)}s`, 16, 92)
    ctx.restore()
  }

  private drawFlashes(flashes: JudgmentFlash[]): void {
    const ctx = this.ctx
    const now = performance.now()
    for (const f of flashes) {
      if (f.until < now) continue
      const x = this.laneX(f.lane)
      const y = this.hitZoneY() - 40
      const alpha = (f.until - now) / 600
      ctx.save()
      ctx.globalAlpha = Math.min(1, alpha)
      ctx.font = '800 22px Orbitron, system-ui, sans-serif'
      ctx.fillStyle = f.judgment === 'miss' ? '#ff4466' : '#fff'
      ctx.shadowColor = f.judgment === 'perfect' ? '#00ffff' : '#ff00e5'
      ctx.shadowBlur = 16
      ctx.textAlign = 'center'
      ctx.fillText(f.judgment.toUpperCase(), x, y)
      ctx.restore()
    }
  }

  private drawScanlines(): void {
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = 0.04
    ctx.fillStyle = '#000'
    for (let y = 0; y < this.h; y += 3) {
      ctx.fillRect(0, y, this.w, 1)
    }
    ctx.restore()
  }
}

export { LEAD_SEC }
