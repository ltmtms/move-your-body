import { defineConfig } from 'vite'

export default defineConfig({
  // relative paths: works on GitHub Pages under any repo name, or at a domain root
  base: './',
  worker: { format: 'es' },
  server: { port: 9876, strictPort: true },
  preview: { port: 9876, strictPort: true },
})
