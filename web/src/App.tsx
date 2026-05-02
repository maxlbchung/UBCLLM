export default function App() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-xl text-center space-y-3 px-6">
        <h1 className="text-3xl font-semibold text-white">UBCLLM</h1>
        <p className="text-sm text-zinc-400">
          Browser-native UBC academic advisor. Scaffold ready &mdash; chat UI, RAG retrieval, and
          Gemma 4 E2B integration land in the next session.
        </p>
        <p className="text-xs text-zinc-500">
          Verify your machine first: open the smoke-test page and confirm Gemma 4 E2B loads under WebGPU.
        </p>
      </div>
    </div>
  )
}
