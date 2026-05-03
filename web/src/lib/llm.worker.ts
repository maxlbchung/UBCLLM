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
