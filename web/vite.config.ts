import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages serves the project at https://<user>.github.io/<repo>/, so the
// app needs to know the sub-path at build time. We default to '/UBCLLM/' (repo
// name) but allow override via VITE_BASE_PATH for custom domains or other hosts.
const base = process.env.VITE_BASE_PATH ?? '/UBCLLM/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  // The bundled WebAssembly + ML weights are huge; warning thresholds at the
  // default 500 kB are noisy and not actionable.
  build: {
    chunkSizeWarningLimit: 2048,
  },
})
