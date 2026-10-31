import './style.css'
import { analyze, audioContext, decodeFile, hashString, renderDemoTrack, SongPlayer, Sfx } from './audio/audio.ts'
import type { HitKits } from './audio/kits.ts'
import { Engine, gradeFor, SLAP_SPEED } from './game/engine.ts'
import { Renderer } from './game/renderer.ts'
import type { BodyFrame, Chart, Difficulty } from './game/types.ts'
import { View } from './game/view.ts'
import { openCamera, PoseTracker } from './pose/tracker.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** target flight time; snapped to whole beats so saucers launch on the beat */
const LEAD: Record<Difficulty, number> = { easy: 1.9, normal: 1.55, hard: 1.25 }

function leadFor(d: Difficulty, bpm: number): number {
  const beat = 60 / bpm
  return Math.max(2, Math.round(LEAD[d] / beat)) * beat
}

const COUNT_IN = 3

const video = $<HTMLVideoElement>('camera')
const canvas = $<HTMLCanvasElement>('stage')
const view = new View(video)
const renderer = new Renderer(canvas, view)

type Screen = 'menu' | 'loading' | 'calibrate' | 'paused' | 'results' | null
function show(screen: Screen): void {
  for (const id of ['menu', 'loading', 'calibrate', 'paused', 'results']) $(id).classList.toggle('active', id === screen)
  document.body.classList.toggle('in-game', screen === null || screen === 'paused' || screen === 'calibrate')
}

function toast(msg: string, ms = 3500): void {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('show')
  window.setTimeout(() => t.classList.remove('show'), ms)
}

function setLoading(text: string, ratio: number, sub = ''): void {
  $('load-text').textContent = text
  $('load-bar').style.width = `${Math.round(ratio * 100)}%`
  $('load-sub').textContent = sub
}

function bestKey(name: string, d: Difficulty): string {
  return `myb.best.${d}.${name}`
}
function readBest(name: string, d: Difficulty): { score: number; grade: string } | null {
  try {
    const v = localStorage.getItem(bestKey(name, d))
    return v ? JSON.parse(v) : null
  } catch {
    return null
  }
}
function writeBest(name: string, d: Difficulty, score: number, grade: string): void {
  try {
    localStorage.setItem(bestKey(name, d), JSON.stringify({ score, grade }))
  } catch {
    /* storage unavailable */
  }
}

// ───────────────────────── state ─────────────────────────
let difficulty: Difficulty = 'normal'
let track: { name: string; file?: File; buffer?: AudioBuffer } | null = null
let chart: Chart | null = null
let chartKey = ''
let tracker: PoseTracker | null = null
let player: SongPlayer | null = null
let engine: Engine | null = null
let sfx: Sfx | null = null
let kits: HitKits | null = null
let kitShown = -1
let mode: 'idle' | 'calibrate' | 'play' | 'paused' = 'idle'
let lastFrame: BodyFrame | null = null
let calibHold = 0
let lastTick = performance.now()
let lastCount = 0

try {
  const d = localStorage.getItem('myb.diff') as Difficulty | null
  if (d === 'easy' || d === 'normal' || d === 'hard') difficulty = d
} catch {
  /* ignore */
}

// ───────────────────────── menu ─────────────────────────
const DIFF_HINT: Record<Difficulty, string> = {
  easy: '輕輕揮手掃過飛碟就得 · a gentle wave counts',
  normal: '要揮得清楚，手掌擺住唔郁唔計 · a clear swipe, resting on it does not count',
  hard: '要快拍！慢嘅揮動唔計 · a quick slap, slow swipes do not count',
}

function refreshMenu(): void {
  $('diff-hint').textContent = DIFF_HINT[difficulty]
  document.querySelectorAll<HTMLButtonElement>('.diff-btn').forEach((b) => {
    const on = b.dataset.diff === difficulty
    b.classList.toggle('active', on)
    b.setAttribute('aria-checked', String(on))
  })
  ;($('start') as HTMLButtonElement).disabled = !track
  $('drop-text').textContent = track ? `♪ ${track.name}` : '上載 MP3 / UPLOAD TRACK'
  $('drop').classList.toggle('loaded', !!track)
  const best = track ? readBest(track.name, difficulty) : null
  $('best').textContent = best ? `BEST ${best.grade} · ${best.score.toLocaleString()}` : ''
}

document.querySelectorAll<HTMLButtonElement>('.diff-btn').forEach((b) =>
  b.addEventListener('click', () => {
    difficulty = b.dataset.diff as Difficulty
    try {
      localStorage.setItem('myb.diff', difficulty)
    } catch {
      /* ignore */
    }
    refreshMenu()
  }),
)

function pickFile(file: File | undefined): void {
  if (!file) return
  if (!/audio|mpeg/.test(file.type) && !/\.(mp3|m4a|wav|ogg|aac)$/i.test(file.name)) {
    toast('請選擇 MP3 音樂檔案')
    return
  }
  track = { name: file.name.replace(/\.[^.]+$/, ''), file }
  chart = null
  refreshMenu()
}

$<HTMLInputElement>('file').addEventListener('change', (e) => pickFile((e.target as HTMLInputElement).files?.[0]))
const drop = $('drop')
drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('over')
})
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  pickFile(e.dataTransfer?.files[0])
})

$('demo').addEventListener('click', () => {
  track = { name: 'DEMO TECHNO 128' }
  chart = null
  refreshMenu()
  void begin()
})
$('start').addEventListener('click', () => void begin())

// ───────────────────────── loading flow ─────────────────────────
async function begin(): Promise<void> {
  if (!track) return
  audioContext() // unlock audio inside the user gesture (iOS)
  sfx ??= new Sfx()
  show('loading')
  try {
    if (!kits) {
      const { HitKits } = await import('./audio/kits.ts')
      kits = HitKits.create(audioContext())
    }
    // camera first so the permission prompt appears while we crunch audio
    if (!video.srcObject) {
      setLoading('CAMERA ACCESS', 0.05, '請允許使用鏡頭 · allow camera')
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('此瀏覽器不支援鏡頭 (需要 HTTPS)')
      await openCamera(video)
      view.updateCover()
    }

    if (!track.buffer) {
      setLoading('DECODING TRACK', 0.15)
      track.buffer = track.file ? await decodeFile(track.file) : await renderDemoTrack()
    }

    const key = `${track.name}|${difficulty}`
    if (!chart || chartKey !== key) {
      setLoading('ANALYZING BEATS', 0.25, 'onset · tempo · beat tracking')
      chart = await analyze(track.buffer, difficulty, hashString(key), (r) =>
        setLoading('ANALYZING BEATS', 0.25 + r * 0.4, `${Math.round(r * 100)}%`),
      )
      chartKey = key
      kits?.prepare(chart.sections.map((x) => x.kit))
      if (chart.notes.length < 4) throw new Error('這首歌找不到足夠節拍，請換另一首')
    }

    if (!tracker) {
      setLoading('LOADING POSE AI', 0.7, 'MediaPipe PoseLandmarker')
      const t = new PoseTracker(video, view.project)
      await t.load((m) => setLoading(m, 0.8, 'MediaPipe PoseLandmarker'))
      tracker = t
      tracker.onFrame = onBody
      tracker.start()
    }
    setLoading('READY', 1, `${chart.bpm} BPM · ${chart.notes.length} saucers`)
    startCalibration()
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : String(err)
    const denied = /Permission|NotAllowed|denied/i.test(msg)
    toast(denied ? '鏡頭權限被拒絕：請在瀏覽器設定允許鏡頭後再試' : `錯誤：${msg}`, 6000)
    show('menu')
    refreshMenu()
  }
}

// ───────────────────────── calibration ─────────────────────────
function startCalibration(): void {
  mode = 'calibrate'
  calibHold = 0
  show('calibrate')
}

$('skip-calib').addEventListener('click', () => startGame())

function updateCalibration(dt: number): void {
  const f = lastFrame
  const ring = $('calib-ring') as unknown as SVGCircleElement
  let msg = '退後一點，讓鏡頭見到你的頭、肩膀和雙手'
  let ok = false
  if (f?.anchor && f.palms.L && f.palms.R) {
    const shoulderY = f.anchor.y
    ok = f.palms.L.y < shoulderY && f.palms.R.y < shoulderY
    msg = ok ? '保持！HOLD…' : '很好！現在舉高雙手 · RAISE BOTH HANDS'
  } else if (f?.anchor) {
    msg = '看到你了！讓雙手都入鏡 · SHOW BOTH HANDS'
  }
  calibHold = ok ? calibHold + dt : Math.max(0, calibHold - dt * 2)
  $('calib-text').textContent = msg
  const C = 2 * Math.PI * 44
  ring.style.strokeDasharray = `${C}`
  ring.style.strokeDashoffset = `${C * (1 - Math.min(1, calibHold / 1))}`
  if (calibHold >= 1) startGame()
}

// ───────────────────────── game ─────────────────────────
function startGame(): void {
  if (!chart || !track?.buffer) return
  player?.stop()
  player = new SongPlayer(track.buffer)
  const p = player
  engine = new Engine(chart, leadFor(difficulty, chart.bpm), view, (ms) => p.timeAt(ms), difficulty)
  kitShown = -1
  engine.onEvent = (e) => {
    renderer.event(e)
    if (e.judgment === 'miss') sfx?.miss()
    else kits?.hit(e.side ?? e.note.side, e.judgment, e.slap, e.note.beat, e.note.cymbal)
    bumpCombo()
  }
  player.play(0.05, -COUNT_IN)
  lastCount = 0
  mode = 'play'
  show(null)
  $('hud').classList.add('active')
  updateHud(true)
}

function onBody(f: BodyFrame): void {
  lastFrame = f
  const unit = view.unit(f.shoulder || view.fallbackAnchor().shoulder)
  renderer.pushTrail(f, SLAP_SPEED * unit)
  if (mode === 'play' && engine && tracker) {
    engine.frameInterval = tracker.frameInterval
    engine.onBody(f)
  }
}

let shownScore = -1
let shownCombo = -1
function updateHud(force = false): void {
  if (!engine || !player) return
  const s = engine.stats
  if (force || s.score !== shownScore) {
    shownScore = s.score
    $('score').textContent = String(s.score).padStart(7, '0')
    const g = s.judged ? gradeFor(s) : '—'
    const rank = $('rank')
    rank.textContent = g
    rank.dataset.grade = g
  }
  if (force || s.combo !== shownCombo) {
    shownCombo = s.combo
    $('combo-n').textContent = String(s.combo)
    $('combo').classList.toggle('visible', s.combo >= 3)
  }
  $('progress').style.width = `${Math.max(0, Math.min(1, player.time() / player.duration)) * 100}%`
}

function bumpCombo(): void {
  const c = $('combo')
  c.classList.remove('bump')
  void c.offsetWidth
  c.classList.add('bump')
}

function pause(): void {
  if (mode !== 'play' || !player) return
  if (player.time() < 0) return
  player.pause()
  mode = 'paused'
  show('paused')
}
function resume(): void {
  if (mode !== 'paused' || !player) return
  player.resume()
  mode = 'play'
  show(null)
}
function quitToMenu(): void {
  player?.stop()
  engine = null
  mode = 'idle'
  $('hud').classList.remove('active')
  show('menu')
  refreshMenu()
}

$('pause').addEventListener('click', pause)
$('resume').addEventListener('click', resume)
$('restart').addEventListener('click', () => {
  player?.stop()
  startCalibration()
  $('hud').classList.remove('active')
})
$('quit').addEventListener('click', quitToMenu)
$('again').addEventListener('click', () => startCalibration())
$('to-menu').addEventListener('click', quitToMenu)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause()
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'p' || e.key === ' ') {
    if (mode === 'play') pause()
    else if (mode === 'paused') resume()
  }
})

function finish(): void {
  if (!engine || !player || !track) return
  player.stop()
  mode = 'idle'
  $('hud').classList.remove('active')
  const s = engine.stats
  const grade = gradeFor(s)
  const g = $('grade')
  g.textContent = grade
  g.dataset.text = grade
  g.dataset.grade = grade
  $('final-score').textContent = s.score.toLocaleString()
  $('r-perfect').textContent = String(s.perfect)
  $('r-great').textContent = String(s.great)
  $('r-good').textContent = String(s.good)
  $('r-miss').textContent = String(s.miss)
  $('r-combo').textContent = String(s.maxCombo)
  $('r-slaps').textContent = String(s.slaps)
  const best = readBest(track.name, difficulty)
  const isBest = !best || s.score > best.score
  if (isBest) writeBest(track.name, difficulty, s.score, grade)
  $('new-best').classList.toggle('visible', isBest && s.score > 0)
  show('results')
}

/** switch the percussion kit when the song enters a new section */
function updateKit(t: number): void {
  if (!chart || !kits) return
  let k = chart.sections[0]?.kit ?? 0
  for (const s of chart.sections) if (s.start <= t) k = s.kit
  if (kits.setKit(k) || kitShown < 0) {
    const first = kitShown < 0
    kitShown = k
    if (first) return
    const b = $('kit')
    b.textContent = `♫ SOUND ▸ ${kits.names[k]}`
    b.classList.remove('show')
    void b.offsetWidth
    b.classList.add('show')
  }
}

// ───────────────────────── main loop ─────────────────────────
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastTick) / 1000)
  lastTick = now

  if (mode === 'calibrate') updateCalibration(dt)

  if ((mode === 'play' || mode === 'paused') && engine && player && chart) {
    const t = player.time()
    if (mode === 'play') {
      engine.update(t)
      // count-in: 3 · 2 · 1 · GO
      const cd = $('countdown')
      if (t < 0) {
        const n = Math.ceil(-t)
        if (n !== lastCount) {
          lastCount = n
          cd.textContent = String(n)
          cd.classList.remove('pop')
          void cd.offsetWidth
          cd.classList.add('pop')
          sfx?.tick()
        }
      } else if (lastCount !== 0) {
        lastCount = 0
        cd.textContent = 'GO!'
        cd.classList.remove('pop')
        void cd.offsetWidth
        cd.classList.add('pop')
        sfx?.tick(true)
      }
      updateKit(t)
      $('lost').classList.toggle('visible', !lastFrame?.anchor || now - (lastFrame?.t ?? 0) > 1500)
      if (player.ended || (engine.finished && t > chart.duration - 0.2) || t > chart.duration + 1) finish()
    }
    renderer.draw(engine, t, lastFrame, chart.beats, dt)
    updateHud()
  } else {
    renderer.drawIdle(lastFrame, dt)
  }
  requestAnimationFrame(frame)
}

function onResize(): void {
  renderer.resize()
  document.body.classList.toggle('portrait', window.innerHeight > window.innerWidth)
}
window.addEventListener('resize', onResize)
window.addEventListener('orientationchange', () => window.setTimeout(onResize, 200))
video.addEventListener('loadedmetadata', () => view.updateCover())
onResize()
refreshMenu()
show('menu')
requestAnimationFrame(frame)
