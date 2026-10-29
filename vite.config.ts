import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  base: '/move-your-body/',
  resolve: {
    alias: {
      '@mediapipe/pose': path.resolve(import.meta.dirname, 'src/shims/mediapipe-pose-stub.ts'),
    },
  },
  server: {
    port: 9876,
    strictPort: true,
  },
  preview: {
    port: 9876,
    strictPort: true,
  },
})
