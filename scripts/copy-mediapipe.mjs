// Puts the MediaPipe Tasks Vision WASM runtime and the pose model into public/
// so the game is fully self-hosted on GitHub Pages (no CDN at play time).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const src = path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const dest = path.join(root, 'public/mediapipe')
const files = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]

mkdirSync(dest, { recursive: true })
for (const f of files) {
  const from = path.join(src, f)
  if (!existsSync(from)) throw new Error(`Missing ${from} — run npm install first`)
  copyFileSync(from, path.join(dest, f))
}
console.log(`copied ${files.length} MediaPipe wasm files → public/mediapipe`)

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
const model = path.join(root, 'public/models/pose_landmarker_lite.task')
if (!existsSync(model)) {
  mkdirSync(path.dirname(model), { recursive: true })
  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`model download failed: ${res.status}`)
  writeFileSync(model, Buffer.from(await res.arrayBuffer()))
  console.log('downloaded pose_landmarker_lite.task → public/models')
}
