/// <reference lib="webworker" />
// WebLLM worker host. The handler internally constructs its own MLCEngine
// and owns the GPUDevice + model pipeline. Running it off the main thread
// makes the GPU pipeline survive page-lifecycle events (background tab
// throttling, brief visibility changes) that otherwise trigger device-lost
// → engine.unload() and the cascade of "Buffer was unmapped" /
// "Model not loaded" errors we kept hitting on the main-thread engine.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

// Diagnostic instrumentation. We monkey-patch `navigator.gpu.requestAdapter`
// before WebLLM's handler is constructed so we can intercept whatever
// adapter + device its `detectGPUDevice` ends up creating. Subscribing to
// `device.lost` here gives us ground truth on *whether* device-loss is the
// proximate cause of the "Buffer was unmapped" errors users see, and
// *when* it fires relative to user actions (visibility changes, sends).
// Events are posted back to the main thread as `{ kind: 'diag', ... }`
// messages, ignored by WebLLM's UUID-keyed proxy and consumed by the
// matching listener in llm.ts.
//
// IMPORTANT: this must run before `new WebWorkerMLCEngineHandler()` so
// the patch is in place when WebLLM's first reload() requests an adapter.
function diagPost(event: string, detail?: Record<string, unknown>) {
  self.postMessage({
    kind: 'diag',
    event,
    timestamp: Date.now(),
    detail: detail ?? null,
  })
}

if (typeof navigator !== 'undefined' && navigator.gpu) {
  const originalRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
  navigator.gpu.requestAdapter = async (
    ...args: Parameters<GPU['requestAdapter']>
  ) => {
    const adapter = await originalRequestAdapter(...args)
    if (!adapter) {
      diagPost('adapter-null')
      return adapter
    }
    // adapter.info is on a relatively recent spec; fall back to vendor/
    // architecture probes for older Chrome.
    const info = adapter.info
    diagPost('adapter-acquired', {
      vendor: info?.vendor ?? null,
      architecture: info?.architecture ?? null,
      device: info?.device ?? null,
      description: info?.description ?? null,
    })
    const originalRequestDevice = adapter.requestDevice.bind(adapter)
    adapter.requestDevice = async (
      ...deviceArgs: Parameters<GPUAdapter['requestDevice']>
    ) => {
      const device = await originalRequestDevice(...deviceArgs)
      diagPost('device-acquired')
      // device.lost is a Promise, not an event — it resolves once and
      // never rejects. Any value here means the device is gone.
      device.lost
        .then((lostInfo) => {
          diagPost('device-lost', {
            reason: lostInfo.reason,
            message: lostInfo.message,
          })
        })
        .catch((err) => {
          // Defensive: spec says device.lost never rejects, but we don't
          // want a stray error to break diagnostics on quirky impls.
          diagPost('device-lost-promise-error', {
            message: err instanceof Error ? err.message : String(err),
          })
        })
      return device
    }
    return adapter
  }
}

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
