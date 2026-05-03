// Lazy-loaded transformers.js MiniLM singleton. Same model as the pipeline
// (sentence-transformers/all-MiniLM-L6-v2 == Xenova/all-MiniLM-L6-v2) so query
// and corpus vectors live in the same space.
import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

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
