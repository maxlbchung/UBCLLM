// Lazy-loaded transformers.js MiniLM singleton. Same model as the pipeline
// (sentence-transformers/all-MiniLM-L6-v2 == Xenova/all-MiniLM-L6-v2) so query
// and corpus vectors live in the same space.
import { env, pipeline, type FeatureExtractionPipeline } from '@xenova/transformers'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

// Skip the local /models/* probe. transformers.js defaults to probing
// `${origin}/models/{MODEL_ID}/config.json` first and only falls back to
// huggingface.co on a network error. Our Cloudflare Pages `_redirects` rule
// `/* /index.html 200` rewrites every unknown path to the app shell with
// status 200 + text/html, so the probe "succeeds" with `<!doctype html>` and
// JSON.parse blows up with `Unexpected token '<', "<!doctype "... is not valid
// JSON` — bricking the first chat message after model load. We don't ship any
// /models/ assets, so disabling the probe just routes the load straight to the
// Hugging Face CDN.
env.allowLocalModels = false

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

export function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_ID, {
      quantized: true,
    }) as Promise<FeatureExtractionPipeline>
  }
  return extractorPromise
}

export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbedder()
  const out = await extractor(text, { pooling: 'mean', normalize: true })
  return new Float32Array(out.data as Float32Array)
}
