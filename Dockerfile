# DeepTrust — multi-stage build for Render
# Build runs in the cloud; no local Docker required.
# Uses node:20-slim (glibc) so onnxruntime-node and tokenizers native bindings work.
# Alpine (musl) causes 502 on model load due to incompatible native modules.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build LLM worker (dist/llm/) then Next.js (standalone)
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Pre-download the default model so the container doesn't fetch at runtime
ENV HF_CACHE_DIR=/app/.hf-cache-build
RUN mkdir -p /app/.hf-cache-build && node scripts/preload-hf-model.cjs

FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --gid 1001 nodejs && useradd --uid 1001 --gid nodejs --shell /bin/false nextjs

# Standalone output: server + minimal node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# LLM worker (required at runtime; path is process.cwd()/dist/llm)
COPY --from=builder /app/dist ./dist
# Worker runs in a separate thread and requires these at runtime; standalone does not trace them.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
RUN npm install @huggingface/transformers onnxruntime-node --omit=dev --ignore-scripts --no-save

# Pre-downloaded model cache (avoids runtime download; worker reads from here)
COPY --from=builder --chown=nextjs:nodejs /app/.hf-cache-build ./.hf-cache
ENV HF_CACHE_DIR=/app/.hf-cache

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
