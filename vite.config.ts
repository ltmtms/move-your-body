import { defineConfig } from 'vite'

export default defineConfig({
  base: '/move-your-body/',
  worker: { format: 'es' },
  server: { port: 9876, strictPort: true },
  preview: { port: 9876, strictPort: true },
})
