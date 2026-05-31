import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..', '..')
const scenePath = resolve(repoRoot, 'web', 'public', 'data', 'home-background.json')

function sceneFileApi(): Plugin {
  return {
    name: 'home-background-scene-api',
    configureServer(server) {
      server.middlewares.use('/api/home-background', (req, res, next) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          res.end(
            existsSync(scenePath)
              ? readFileSync(scenePath, 'utf8')
              : JSON.stringify({ schemaVersion: 1, boxes: [] }, null, 2),
          )
          return
        }

        if (req.method !== 'POST') {
          next()
          return
        }

        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            mkdirSync(dirname(scenePath), { recursive: true })
            writeFileSync(scenePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, path: scenePath }))
          } catch (error) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : 'Invalid JSON',
              }),
            )
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), sceneFileApi()],
})
