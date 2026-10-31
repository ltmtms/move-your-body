import type { Engine, HitEvent, NoteState } from './engine.ts'
import { SKELETON_EDGES } from '../pose/tracker.ts'
import type { BodyFrame, Side } from './types.ts'
import type { View } from './view.ts'

const COLOR: Record<Side, string> = { L: '#00f0ff', R: '#ff2bd6' }
const JUDGE_COLOR = { perfect: '#7dfcff', great: '#a6ff4d', good: '#ffd84d', miss: '#ff3860' }
const JUDGE_TEXT = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' }
/** perspective strength: saucers start at 1/(1+DEPTH) of their final size */
const DEPTH = 7

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  color: string
  size: number
}

interface Popup {
  x: number
  y: number
  text: string
  sub: string
  color: string
  born: number
}

function makeSaucerSprite(color: string): HTMLCanvasElement {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const cx = S / 2
  const cy = S / 2
  // outer glow
  const glow = g.createRadialGradient(cx, cy, 10, cx, cy, S / 2)
  glow.addColorStop(0, color + 'aa')
  glow.addColorStop(0.45, color + '33')
  glow.addColorStop(1, color + '00')
  g.fillStyle = glow
  g.fillRect(0, 0, S, S)
  g.shadowColor = color
  g.shadowBlur = 18
  // hull
  g.fillStyle = '#0b0420'
  g.strokeStyle = color
  g.lineWidth = 6
  g.beginPath()
  g.ellipse(cx, cy + 8, 92, 30, 0, 0, Math.PI * 2)
  g.fill()
  g.stroke()
  // dome
  const dome = g.createLinearGradient(cx, cy - 60, cx, cy)
  dome.addColorStop(0, '#ffffff')
  dome.addColorStop(1, color)
  g.fillStyle = dome
  g.beginPath()
  g.ellipse(cx, cy - 2, 42, 42, 0, Math.PI, 0)
  g.closePath()
  g.globalAlpha = 0.85
  g.fill()
  g.globalAlpha = 1
  // inner rim
  g.lineWidth = 3
  g.strokeStyle = '#ffffff'
  g.beginPath()
  g.ellipse(cx, cy + 6, 70, 18, 0, 0, Math.PI * 2)
  g.stroke()
  // lights
  g.fillStyle = '#ffffff'
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * (0.15 + (0.7 * i) / 6)
    g.beginPath()
    g.arc(cx - Math.cos(a) * 78, cy + 8 + Math.sin(a) * 20, 5, 0, Math.PI * 2)
    g.fill()
  }
  return c
}

export class Renderer {
  private ctx: CanvasRenderingContext2D
  private canvas: HTMLCanvasElement
  private view: View
  private sprites: Record<Side, HTMLCanvasElement>
  private particles: Particle[] = []
  private popups: Popup[] = []
  private trails: Record<Side, { x: number; y: number; t: number; fast: boolean }[]> = { L: [], R: [] }
  private flash = 0
  private beatPulse = 0
  private lastBeatIdx = -1
  dpr = 1

  constructor(canvas: HTMLCanvasElement, view: View) {
    this.canvas = canvas
    this.view = view
    this.ctx = canvas.getContext('2d')!
    this.sprites = { L: makeSaucerSprite(COLOR.L), R: makeSaucerSprite(COLOR.R) }
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    // phones: cap the backing store so fill-rate never limits the frame rate
    const cap = Math.min(rect.width, rect.height) < 600 ? 1.5 : 2
    this.dpr = Math.min(window.devicePixelRatio || 1, cap)
    this.canvas.width = Math.round(rect.width * this.dpr)
    this.canvas.height = Math.round(rect.height * this.dpr)
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.view.resize(rect.width, rect.height)
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.view.w, this.view.h)
  }

  pushTrail(frame: BodyFrame, slapSpeedPx: number): void {
    for (const side of ['L', 'R'] as Side[]) {
      const p = frame.palms[side]
      const tr = this.trails[side]
      if (!p) {
        tr.length = 0
        continue
      }
      tr.push({ x: p.x, y: p.y, t: performance.now(), fast: Math.hypot(p.vx, p.vy) > slapSpeedPx })
      if (tr.length > 10) tr.shift()
    }
  }

  event(e: HitEvent): void {
    const { judgment: j, pos } = e
    const color = JUDGE_COLOR[j]
    this.popups.push({
      x: pos.x,
      y: pos.y - 30,
      text: e.slap ? 'SLAP!' : e.tooSlow ? 'TOO STILL' : JUDGE_TEXT[j],
      sub: e.slap ? JUDGE_TEXT[j] : e.tooSlow ? 'SWIPE IT!' : '',
      color: e.slap ? '#ffffff' : color,
      born: performance.now(),
    })
    if (j === 'miss') return
    const n = e.slap ? 46 : j === 'perfect' ? 30 : 18
    const base = COLOR[e.note.side]
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = (e.slap ? 500 : 280) * (0.3 + Math.random())
      this.particles.push({
        x: pos.x,
        y: pos.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        max: 0.4 + Math.random() * 0.4,
        color: i % 3 === 0 ? '#ffffff' : base,
        size: 2 + Math.random() * (e.slap ? 5 : 3),
      })
    }
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400)
    if (e.slap) this.flash = 1
  }

  draw(engine: Engine, songTime: number, frame: BodyFrame | null, beats: number[], dt: number): void {
    const ctx = this.ctx
    const { w, h } = this.view
    ctx.clearRect(0, 0, w, h)

    // beat pulse drives glow intensity across the scene
    let bi = this.lastBeatIdx
    while (bi + 1 < beats.length && beats[bi + 1] <= songTime) bi++
    if (bi !== this.lastBeatIdx) {
      this.lastBeatIdx = bi
      this.beatPulse = 1
    }
    this.beatPulse = Math.max(0, this.beatPulse - dt * 4)

    this.drawFloor(songTime, beats, engine.lead)
    this.drawSkeleton(frame)

    const upcoming: NoteState[] = []
    for (const n of engine.active(songTime - 0.4, songTime + engine.lead)) upcoming.push(n)
    // far saucers first so near ones overlap them
    upcoming.sort((a, b) => b.time - a.time)
    this.drawGuides(engine, upcoming, songTime, frame)
    for (const n of upcoming) this.drawSaucer(engine, n, songTime, frame)

    this.drawTrails()
    this.drawPalms(frame)
    this.drawParticles(dt)
    this.drawPopups()

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.18})`
      ctx.fillRect(0, 0, w, h)
      this.flash = Math.max(0, this.flash - dt * 5)
    }
  }

  /** menus / calibration: just the player's neon skeleton and palms */
  drawIdle(frame: BodyFrame | null, dt: number): void {
    this.ctx.clearRect(0, 0, this.view.w, this.view.h)
    this.drawSkeleton(frame)
    this.drawTrails()
    this.drawPalms(frame)
    this.drawParticles(dt)
  }

  /** synthwave floor: horizontal lines are the song's beats rushing at you */
  private drawFloor(songTime: number, beats: number[], lead: number): void {
    const ctx = this.ctx
    const { w, h } = this.view
    const vp = this.view.vanish()
    const pulse = this.beatPulse
    ctx.save()
    const hz = ctx.createLinearGradient(0, vp.y - 40, 0, vp.y + 40)
    hz.addColorStop(0, 'rgba(255,43,214,0)')
    hz.addColorStop(0.5, `rgba(255,43,214,${0.25 + pulse * 0.35})`)
    hz.addColorStop(1, 'rgba(255,43,214,0)')
    ctx.fillStyle = hz
    ctx.fillRect(0, vp.y - 40, w, 80)

    ctx.globalCompositeOperation = 'lighter'
    ctx.lineWidth = 1.5
    // radiating rails
    const rails = 14
    for (let i = 0; i <= rails; i++) {
      const x = -w * 0.6 + (w * 2.2 * i) / rails
      ctx.strokeStyle = `rgba(160,60,255,${0.18 + pulse * 0.1})`
      ctx.beginPath()
      ctx.moveTo(vp.x, vp.y)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    // beat lines
    const s0 = 1 / (1 + DEPTH)
    for (let i = Math.max(0, this.lastBeatIdx - 1); i < beats.length; i++) {
      const z = (beats[i] - songTime) / (lead * 1.4)
      if (z > 1) break
      if (z < -0.05) continue
      const s = 1 / (1 + DEPTH * Math.max(0, z))
      const k = (s - s0) / (1 - s0)
      const y = vp.y + (h - vp.y) * k
      const a = Math.min(1, k * 1.5) * 0.55
      ctx.strokeStyle = `rgba(0,240,255,${a})`
      ctx.lineWidth = 1 + k * 2.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    ctx.restore()
  }

  private flight(engine: Engine, n: NoteState, songTime: number, frame: BodyFrame | null) {
    const target = engine.targetOf(n, frame)
    const vp = this.view.vanish()
    const z = (n.time - songTime) / engine.lead // 1 = spawn, 0 = target, <0 = past
    const s0 = 1 / (1 + DEPTH)
    const s = 1 / (1 + DEPTH * z)
    const k = (s - s0) / (1 - s0)
    return {
      target,
      z,
      scale: s,
      pos: { x: vp.x + (target.x - vp.x) * k, y: vp.y + (target.y - vp.y) * k },
    }
  }

  private drawGuides(engine: Engine, notes: NoteState[], songTime: number, frame: BodyFrame | null): void {
    const ctx = this.ctx
    const vp = this.view.vanish()
    const { shoulder } = engine.layout(frame)
    const R = this.view.saucerRadius(shoulder)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const n of notes) {
      if (n.state !== 'pending') continue
      const f = this.flight(engine, n, songTime, frame)
      if (f.z < 0) continue
      const c = COLOR[n.side]
      const near = 1 - Math.min(1, f.z)
      // rail from the vanishing point
      ctx.strokeStyle = c
      ctx.globalAlpha = 0.12 + near * 0.25
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(vp.x, vp.y)
      ctx.lineTo(f.target.x, f.target.y)
      ctx.stroke()
      // target ring + approach ring closing in on the beat
      ctx.globalAlpha = 0.15 + near * 0.55
      ctx.setLineDash([6, 6])
      ctx.beginPath()
      ctx.arc(f.target.x, f.target.y, R, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      // approach ring only for the final stretch, closing exactly on the beat
      if (f.z < 0.6) {
        ctx.lineWidth = 3
        ctx.globalAlpha = 0.9 * (1 - f.z / 0.6)
        ctx.beginPath()
        ctx.arc(f.target.x, f.target.y, R * (1 + f.z * 2), 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    // link double saucers with a beam
    const groups = new Map<number, NoteState[]>()
    for (const n of notes) if (n.state === 'pending') groups.set(n.group, [...(groups.get(n.group) ?? []), n])
    for (const g of groups.values()) {
      if (g.length < 2) continue
      const a = this.flight(engine, g[0], songTime, frame)
      const b = this.flight(engine, g[1], songTime, frame)
      if (a.z < 0) continue
      ctx.globalAlpha = 0.5 * (1 - Math.min(1, a.z))
      ctx.strokeStyle = '#ffe14d'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(a.pos.x, a.pos.y)
      ctx.lineTo(b.pos.x, b.pos.y)
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawSaucer(engine: Engine, n: NoteState, songTime: number, frame: BodyFrame | null): void {
    const ctx = this.ctx
    const f = this.flight(engine, n, songTime, frame)
    const { shoulder } = engine.layout(frame)
    const R = this.view.saucerRadius(shoulder)
    if (n.state === 'hit') return
    let alpha = Math.min(1, (1 - f.z) * 3)
    let pos = f.pos
    let size = R * 2.4 * f.scale
    if (n.state === 'miss') {
      // missed saucers zoom past the player and fade out
      const age = (performance.now() - (n.resolvedAt ?? 0)) / 1000
      alpha = Math.max(0, 0.6 - age * 2)
      size *= 1 + age * 2
      pos = { x: pos.x, y: pos.y + age * 200 }
      if (alpha <= 0) return
    }
    const spin = Math.sin(songTime * 6 + n.id) * 0.18
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(pos.x, pos.y)
    ctx.rotate(spin)
    const pulse = 1 + this.beatPulse * 0.06
    ctx.drawImage(this.sprites[n.side], (-size / 2) * pulse, (-size / 2) * pulse, size * pulse, size * pulse)
    ctx.restore()
  }

  private drawSkeleton(frame: BodyFrame | null): void {
    if (!frame) return
    const ctx = this.ctx
    const j = frame.joints
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(140,90,255,0.45)'
    ctx.lineWidth = 6
    for (const [a, b] of SKELETON_EDGES) {
      const p = j[a]
      const q = j[b]
      if (!p || !q) continue
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(q.x, q.y)
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawTrails(): void {
    const ctx = this.ctx
    const now = performance.now()
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    for (const side of ['L', 'R'] as Side[]) {
      const tr = this.trails[side].filter((p) => now - p.t < 220)
      this.trails[side] = tr
      for (let i = 1; i < tr.length; i++) {
        const a = tr[i - 1]
        const b = tr[i]
        const k = i / tr.length
        ctx.strokeStyle = b.fast ? '#ffffff' : COLOR[side]
        ctx.globalAlpha = k * (b.fast ? 0.9 : 0.5)
        ctx.lineWidth = (b.fast ? 18 : 8) * k
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  private drawPalms(frame: BodyFrame | null): void {
    if (!frame) return
    const ctx = this.ctx
    const unit = this.view.unit(frame.shoulder || this.view.fallbackAnchor().shoulder)
    const r = Math.max(14, unit * 0.2)
    for (const side of ['L', 'R'] as Side[]) {
      const p = frame.palms[side]
      if (!p) continue
      const c = COLOR[side]
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2)
      g.addColorStop(0, c + 'cc')
      g.addColorStop(1, c + '00')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(p.x, p.y, r * 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.globalAlpha = p.predicted ? 0.4 : 0.95
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }

  private drawParticles(dt: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    this.particles = this.particles.filter((p) => {
      p.life += dt
      if (p.life >= p.max) return false
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vx *= 0.92
      p.vy = p.vy * 0.92 + 300 * dt
      ctx.globalAlpha = 1 - p.life / p.max
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
      return true
    })
    ctx.restore()
  }

  private drawPopups(): void {
    const ctx = this.ctx
    const now = performance.now()
    const base = Math.max(18, Math.min(34, this.view.minDim * 0.05))
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    this.popups = this.popups.filter((p) => {
      const age = (now - p.born) / 1000
      if (age > 0.7) return false
      const k = age / 0.7
      const scale = age < 0.08 ? 0.6 + age * 5 : 1
      ctx.globalAlpha = 1 - k * k
      ctx.font = `900 ${base * scale}px Orbitron, system-ui, sans-serif`
      const y = p.y - k * 40
      ctx.lineWidth = 6
      ctx.strokeStyle = p.color === '#ffffff' ? '#ff2bd6' : '#05010f'
      ctx.strokeText(p.text, p.x, y)
      ctx.fillStyle = p.color
      ctx.fillText(p.text, p.x, y)
      if (p.sub) {
        ctx.font = `700 ${base * 0.55}px Orbitron, system-ui, sans-serif`
        ctx.fillStyle = '#7dfcff'
        ctx.fillText(p.sub, p.x, y + base * 0.9)
      }
      return true
    })
    ctx.restore()
  }
}
