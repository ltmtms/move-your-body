import './style.css'
import { analyzeAudioFile } from './audio/beatAnalyzer.ts'
import { GameEngine } from './game/gameEngine.ts'
import { GameRenderer } from './game/renderer.ts'
import { openFrontCamera, PoseTracker } from './pose/poseTracker.ts'

type GamePhase = 'landing' | 'analyze' | 'ready' | 'play' | 'results'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export function mountApp(root: HTMLElement): void {
  let selectedFile: File | null = null
  let audioBlobUrl: string | null = null
  let bpm = 120
  let engine: GameEngine | null = null
  let pose: PoseTracker | null = null
  let cameraStream: MediaStream | null = null

  const video = el('video')
  video.className = 'camera-feed'
  video.setAttribute('playsinline', 'true')

  const canvas = el('canvas')
  canvas.className = 'game-canvas'

  const shell = el('div', 'shell')
  const hud = el('div', 'overlay')
  const stage = el('div', 'stage')
  stage.append(video, canvas)

  const title = el('h1', 'title', 'MOVE YOUR BODY')
  const tagline = el('p', 'tagline', 'Techno rhythm · webcam palms · hit the neon disks')
  const status = el('p', 'status')
  const progressWrap = el('div', 'progress hidden')
  const progressBar = el('div', 'progress-bar')
  progressWrap.append(progressBar)

  const fileInput = el('input') as HTMLInputElement
  fileInput.type = 'file'
  fileInput.accept = 'audio/mpeg,audio/mp3,.mp3'
  fileInput.className = 'file-input'
  fileInput.id = 'mp3-input'

  const fileLabel = el('label', 'btn secondary', 'Choose MP3') as HTMLLabelElement
  fileLabel.htmlFor = 'mp3-input'

  const startBtn = el('button', 'btn primary', 'Start game') as HTMLButtonElement
  startBtn.disabled = true

  const panel = el('div', 'panel')
  panel.append(title, tagline, status, progressWrap, fileLabel, fileInput, startBtn)

  const privacy = el(
    'p',
    'privacy',
    'Camera stays on your device — no video is uploaded.',
  )

  hud.append(panel, privacy)
  shell.append(stage, hud)
  root.append(shell)

  const renderer = new GameRenderer(canvas, video)

  const resize = () => renderer.resize()
  window.addEventListener('resize', resize)
  resize()

  function setPhase(next: GamePhase): void {
    panel.classList.toggle('compact', next === 'play')
    privacy.classList.toggle('hidden', next === 'play')
  }

  function setStatus(text: string): void {
    status.textContent = text
  }

  function setProgress(ratio: number, visible: boolean): void {
    progressWrap.classList.toggle('hidden', !visible)
    progressBar.style.width = `${Math.round(ratio * 100)}%`
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    selectedFile = file
    startBtn.disabled = false
    setStatus(`Track: ${file.name}`)
  })

  startBtn.addEventListener('click', () => {
    if (!selectedFile) return
    void runStartFlow()
  })

  async function runStartFlow(): Promise<void> {
    if (!selectedFile) return
    startBtn.disabled = true
    fileLabel.classList.add('hidden')
    fileInput.classList.add('hidden')
    setPhase('analyze')
    setStatus('Analyzing beats…')
    setProgress(0.2, true)

    try {
      const result = await analyzeAudioFile(selectedFile)
      bpm = result.bpmEstimate

      if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl)
      const blob = new Blob([await selectedFile.arrayBuffer()], { type: 'audio/mpeg' })
      audioBlobUrl = URL.createObjectURL(blob)

      setProgress(0.45, true)
      setStatus('Requesting camera…')

      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('Camera API unavailable. Use HTTPS or localhost.')
        startBtn.disabled = false
        return
      }

      cameraStream = await openFrontCamera(video)
      setProgress(0.55, true)
      setStatus('Loading pose model (MoveNet)…')

      pose = new PoseTracker(video)
      await pose.load((msg, ratio) => {
        setStatus(msg)
        setProgress(0.55 + ratio * 0.4, true)
      })
      pose.start()

      setProgress(1, true)
      setPhase('ready')
      await countdown()
      setPhase('play')
      panel.classList.add('hidden')

      engine = new GameEngine({
        renderer,
        notes: result.notes,
        audioBlobUrl: audioBlobUrl!,
        bpm,
        poseEstimate: () => pose!.estimateHands(),
        onEnd: showResults,
      })
      await engine.start()
    } catch (err) {
      console.error(err)
      setStatus(
        err instanceof Error ? err.message : 'Something failed — check camera permission.',
      )
      setProgress(0, false)
      startBtn.disabled = false
      fileLabel.classList.remove('hidden')
      fileInput.classList.remove('hidden')
    }
  }

  async function countdown(): Promise<void> {
    for (const n of [3, 2, 1, 'GO!']) {
      setStatus(String(n))
      setProgress(0, false)
      await new Promise((r) => setTimeout(r, n === 'GO!' ? 500 : 700))
    }
  }

  function showResults(): void {
    setPhase('results')
    panel.classList.remove('hidden')
    const stats = engine?.getStats()
    engine?.stop()
    engine = null
    pose?.stop()
    cameraStream?.getTracks().forEach((t) => t.stop())
    setProgress(0, false)
    setStatus(
      stats
        ? `Done! Score ${stats.score} · Max combo ${stats.maxCombo} · Perfect ${stats.perfect} · Good ${stats.good} · Miss ${stats.miss}`
        : 'Track complete',
    )
    startBtn.textContent = 'Play again'
    startBtn.disabled = false
    fileLabel.classList.remove('hidden')
    fileInput.classList.remove('hidden')
  }

  setPhase('landing')
  setStatus('Upload an MP3 to generate a beat chart.')
}

mountApp(document.querySelector('#app')!)
