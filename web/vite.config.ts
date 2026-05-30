import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// GitHub Pages serves the project at https://<user>.github.io/<repo>/, so the
// app needs to know the sub-path at build time. We default to '/UBCLLM/' (repo
// name) but allow override via VITE_BASE_PATH for custom domains or other hosts.
const base = process.env.VITE_BASE_PATH ?? '/UBCLLM/'

// GitHub Pages has no SPA history-fallback: a hard refresh or direct hit on a
// client route like /UBCLLM/app returns Pages' 404 page, not our app. Copying
// the built index.html to 404.html makes Pages serve the same bundle for any
// unmatched path; the history-API router (src/lib/router.ts) then reads
// window.location.pathname and renders the right route. Asset URLs in
// index.html are absolute (base-prefixed), so the copy works from any depth.
function spaFallback(): Plugin {
  let outDir = 'dist'
  let root = process.cwd()
  return {
    name: 'spa-404-fallback',
    apply: 'build',
    configResolved(cfg) {
      outDir = cfg.build.outDir
      root = cfg.root
    },
    closeBundle() {
      const index = resolve(root, outDir, 'index.html')
      if (existsSync(index)) {
        copyFileSync(index, resolve(root, outDir, '404.html'))
      }
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), spaFallback()],
  // The bundled WebAssembly + ML weights are huge; warning thresholds at the
  // default 500 kB are noisy and not actionable.
  build: {
    chunkSizeWarningLimit: 2048,
  },
})
