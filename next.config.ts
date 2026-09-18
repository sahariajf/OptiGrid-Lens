import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle in .next/standalone so the Docker
  // fallback image stays small and needs no node_modules at runtime.
  output: "standalone",
}

export default nextConfig
