// Copies the MediaPipe Tasks Vision WASM runtime into public/ so the game is
// fully self-hosted on GitHub Pages (no CDN dependency at play time).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
