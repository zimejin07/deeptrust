# Deploying DeepTrust on Render

The app is containerized with **Docker**. You do **not** need Docker installed locally—Render builds the image in the cloud when you push.

## Prerequisites

- Git repo pushed to GitHub (or GitLab)
- Account on [Render](https://render.com)

## Deploy steps

1. Go to [dashboard.render.com](https://dashboard.render.com), connect your GitHub repo.
2. Add a **Web Service**.
3. Set:
   - **Build:** Docker (Render will use the repo `Dockerfile`).
   - **Plan:** See [Memory and plan](#memory-and-plan) below.
4. Create the service. Render builds and deploys on each push.

**Blueprint:** Alternatively, use the repo’s `render.yaml` (Blueprint deploy) so the service is defined in code.

## Memory and plan

Render **Free** instances have **512 MB RAM**. Model loading often exceeds this:

- **SmolLM2-360M (q4)** ≈ 300–450 MB for weights alone, plus Node, Next.js, worker, and inference → typically **OOM on Free** (502 when loading).
- **SmolLM2-135M (q4)** ≈ 150–200 MB → may work on Free but is tight; 502 can still occur under load.

**Recommendations:**

- **Free tier (512 MB):** Set env `HF_MODEL=HuggingFaceTB/SmolLM2-135M-Instruct` and use the 135M model (q4) in the UI. If you still get 502 on “Load model”, the instance is likely OOM — upgrade to Starter.
- **Starter (2 GB) or higher:** Safe for SmolLM2-360M (q4) and 135M. Use Starter if you need 360M or reliable inference.

## Environment variables (optional)

- `HF_MODEL` — Hugging Face model id (default in code). On Free tier, use `HuggingFaceTB/SmolLM2-135M-Instruct` to reduce OOM risk.
- `HF_CACHE_DIR` — Where to cache model files (default `./.hf-cache`). On ephemeral disks this is lost between restarts; models re-download on cold start.
- `DEEPTRUST_LOAD_MODEL_AT_STARTUP` — Set to `0` or `false` to disable loading the model when the server starts (default: load at startup). Use this only if you prefer to load on first user request.

## Notes

- **Model at startup:** The app loads the default model (from `HF_MODEL`, or 135M q4) when the Node server starts, so the first user request does not wait for download/load. If preload fails (e.g. OOM), the server still starts and the UI "Load model" button can be used to retry.
- **First deploy/cold start** can be slow while the model downloads and loads during server boot; subsequent requests are fast.
- **Standalone:** The image uses Next.js `output: "standalone"` for a smaller build and includes the compiled LLM worker under `dist/llm/`.
