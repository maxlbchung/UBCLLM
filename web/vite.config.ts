import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The app is served at the root of its custom domain (https://reodite.com/ on
// Cloudflare Pages), so the Vite base is '/'. VITE_BASE_PATH overrides it for
// sub-path hosts (e.g. a GitHub Pages project URL like /<repo>/).
const base = process.env.VITE_BASE_PATH ?? '/'

// SPA history-fallback lives in web/public/_redirects ("/* /index.html 200"):
// Cloudflare Pages serves the app shell with a 200 for any path that isn't a
// built asset, so client routes like /app survive a hard refresh. We used to
// also copy index.html -> 404.html (the GitHub Pages mechanism), but on
// Cloudflare a 404.html SHADOWS the _redirects 200 rewrite and forced a 404
// status on every deep link, so it's intentionally no longer generated.
export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  // The bundled WebAssembly + ML weights are huge; warning thresholds at the
  // default 500 kB are noisy and not actionable.
  build: {
    chunkSizeWarningLimit: 2048,
  },
})
