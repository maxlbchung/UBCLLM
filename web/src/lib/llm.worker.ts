/// <reference lib="webworker" />
// WebLLM worker host. The handler internally constructs its own MLCEngine
// and owns the GPUDevice + model pipeline. Running it off the main thread
// makes the GPU pipeline survive page-lifecycle events (background tab
// throttling, brief visibility changes) that otherwise trigger device-lost
// → engine.unload() and the cascade of "Buffer was unmapped" /
// "Model not loaded" errors we kept hitting on the main-thread engine.
//
// IMPORTANT: do NOT postMessage from this worker for any purpose other than
// WebLLM's own RPC. WebLLM's `WebWorkerMLCEngine` on the main thread sets
// `worker.onmessage = …` and routes every inbound message through its
// switch over `msg.kind`. Any message with a kind it doesn't recognize
// (including the `kind: 'diag'` diagnostic posts we used to emit) throws
// `UnknownMessageKindError` synchronously inside that handler, which fires
// as an unhandled error during every chat stream and corrupts the engine
// state. If we ever need worker→main signalling again, use a
// `BroadcastChannel` rather than `self.postMessage` — that bypasses
// WebLLM's onmessage handler entirely. The GPU diag bridge below does
// exactly that.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

// GPU diagnostic bridge: surface device.lost, GPU uncaptured errors,
// and adapter/device acquisition events to the main thread via a
// BroadcastChannel so the diag ring in lib/llm.ts can capture them.
// Required because the "Buffer was unmapped before mapping was
// resolved" failure mode has multiple plausible triggers (device.lost,
// validation error, internal error, OOM), and the main-thread error
// message we get back via the RPC reject is the same string for all of
// them — we can only tell them apart by listening on the worker side.
//
// Channel name is fixed and matches the subscriber in lib/llm.ts.
// Worker→main only; we never receive on this channel.
const DIAG_CHANNEL_NAME = 'ubcllm-gpu-diag'
const diagChannel = new BroadcastChannel(DIAG_CHANNEL_NAME)
function postDiag(event: string, detail?: Record<string, unknown>): void {
  try {
    diagChannel.postMessage({ event, detail: detail ?? null, ts: Date.now() })
  } catch {
    /* page navigated away; nothing to do */
  }
}

if (typeof navigator !== 'undefined' && navigator.gpu) {
  const originalRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
  navigator.gpu.requestAdapter = async (
    ...args: Parameters<GPU['requestAdapter']>
  ) => {
    const adapter = await originalRequestAdapter(...args)
    if (!adapter) return adapter
    postDiag('gpu-adapter-acquired', {
      info: 'info' in adapter ? { ...adapter.info } : null,
    })
    const originalRequestDevice = adapter.requestDevice.bind(adapter)
    adapter.requestDevice = async (
      ...deviceArgs: Parameters<GPUAdapter['requestDevice']>
    ) => {
      const device = await originalRequestDevice(...deviceArgs)
      postDiag('gpu-device-acquired')
      // device.lost is a one-shot Promise; resolve = device is gone.
      // When it fires, every pending mapAsync on the device synchronously
      // rejects with AbortError "Buffer was unmapped before mapping was
      // resolved" — so this event is the smoking gun if it shows up
      // milliseconds before our streamChat sees that error.
      device.lost
        .then((info) => {
          postDiag('gpu-device-lost', {
            reason: info.reason,
            message: info.message,
          })
          console.warn('[llm.worker] GPUDevice lost', {
            reason: info.reason,
            message: info.message,
          })
        })
        .catch(() => {
          /* spec says device.lost never rejects; ignore if it does */
        })
      // Uncaught GPU errors (validation, out-of-memory, internal) that
      // were NOT inside an error scope. WebLLM wraps createBuffer in
      // pushErrorScope so most allocation errors are scoped and
      // logged separately, but anything that escapes the scope lands
      // here. Worth capturing because it's another path to device.destroy
      // depending on driver behavior.
      device.addEventListener('uncapturederror', (e) => {
        const errEvent = e as GPUUncapturedErrorEvent
        const err = errEvent.error
        postDiag('gpu-uncaptured-error', {
          message: err.message,
          type: err.constructor?.name ?? 'unknown',
        })
        console.error('[llm.worker] GPU uncaptured error', err)
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

self.onerror = (event) => {
  console.error('[llm.worker] uncaught', event)
}
self.onunhandledrejection = (event) => {
  console.error('[llm.worker] unhandled rejection', event.reason)
}
