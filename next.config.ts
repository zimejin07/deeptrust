import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for @huggingface/transformers in API routes: use Node runtime
  // for onnxruntime-node instead of bundling (which can break or hang).
  serverExternalPackages: ["onnxruntime-node"],
  // Smaller Docker image: output standalone server + minimal node_modules
  output: "standalone",
};

export default nextConfig;
