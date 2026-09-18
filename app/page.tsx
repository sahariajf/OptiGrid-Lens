export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 p-8">
      <h1 className="font-semibold text-2xl">Shakti</h1>
      <p className="text-sm opacity-70">
        LLM-assisted operator directive interpretation and 24-hour campus energy optimization.
      </p>
      <ul className="space-y-1 font-mono text-sm">
        <li>GET /health</li>
        <li>POST /optimize-energy</li>
      </ul>
    </main>
  )
}
