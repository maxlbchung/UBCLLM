import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// The app is served at the root of its custom domain (https://reodite.com/ on
// Cloudflare Pages), so the Vite base is '/'. VITE_BASE_PATH overrides it for
// sub-path hosts (e.g. a GitHub Pages project URL like /<repo>/).
const base = process.env.VITE_BASE_PATH ?? '/'

// Static hosts have no SPA history-fallback: a hard refresh or direct hit on a
// client route like /app returns the host's 404 page, not our app. On
// Cloudflare Pages, public/_redirects ("/* /index.html 200") rewrites any
// unmatched path to the app shell with a 200. Copying index.html to 404.html
// is a belt-and-suspenders fallback that also keeps `vite preview` and other
// static hosts working; the history-API router (src/lib/router.ts) then reads
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
