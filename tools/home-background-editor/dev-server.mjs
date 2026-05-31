import { createServer } from 'vite'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT ?? 5194)

const server = await createServer({
  root,
  configFile: `${root}/vite.config.ts`,
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
  },
})

await server.listen()
server.printUrls()

const close = async () => {
  await server.close()
  process.exit(0)
}

process.once('SIGINT', close)
process.once('SIGTERM', close)
setInterval(() => {}, 2 ** 30)
