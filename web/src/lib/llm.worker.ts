/// <reference lib="webworker" />
// WebLLM worker host. The handler internally constructs its own MLCEngine
// and owns the GPUDevice + model pipeline. Running it off the main thread
// makes the GPU pipeline survive page-lifecycle events (background tab
// throttling, brief visibility changes) that otherwise trigger device-lost
// → engine.unload() and the cascade of "Buffer was unmapped" /
// "Model not loaded" errors we kept hitting on the main-thread engine.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

const handler = new WebWorkerMLCEngineHandler()

self.onmessage = (event: MessageEvent) => {
  handler.onmessage(event)
}

// Catch failures that don't go through the handler's promise plumbing —
// e.g. import-time throws, postMessage of a non-cloneable value, or any
// rejected promise the handler forgot to attach a .catch to. Without this
// they'd silently land in the worker's devtools console (which the user
// has to open the *worker* inspector to see). Logging from here at least
// surfaces them in the main-thread console too via the worker.onerror
// hook in llm.ts.
self.onerror = (event) => {
  console.error('[llm.worker] uncaught', event)
}
self.onunhandledrejection = (event) => {
  console.error('[llm.worker] unhandled rejection', event.reason)
}
