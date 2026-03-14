# Deploying DeepTrust (fly.io / Render)

The app is containerized with **Docker**. You do **not** need Docker installed locally—both fly.io and Render build the image in the cloud when you push.

## Prerequisites

- Git repo pushed to GitHub (or GitLab)
- Account on [fly.io](https://fly.io) and/or [Render](https://render.com)

## Option A: Fly.io

1. Install the CLI: https://fly.io/docs/hands-on/install-flyctl/
2. Log in: `fly auth login`
3. From the repo root, run:
   ```bash
   fly launch
   ```
   - Pick an app name (or accept the default from `fly.toml`)
   - Choose a region
   - Do **not** add a Postgres or Redis if prompted (not required for this app)
4. Deploy:
   ```bash
   fly deploy
   ```
5. Open the app: `fly open`

**Config:** Edit `fly.toml` to change app name, region, or VM size. The LLM worker downloads models at runtime; for the 360M model, consider `memory = "2gb"` under `[vm]` if you see OOM errors.

## Option B: Render

1. Go to [dashboard.render.com](https://dashboard.render.com), connect your GitHub repo.
2. Add a **Web Service**.
3. Set:
   - **Build:** Docker (Render will use the repo `Dockerfile`).
   - **Plan:** Starter (2GB RAM) or higher if you use larger models; Free (512MB) may OOM when loading the model.
4. Create the service. Render builds and deploys on each push.

**Blueprint:** Alternatively, use the repo’s `render.yaml` (Blueprint deploy) so the service is defined in code.

## Environment variables (optional)

- `HF_MODEL` — Hugging Face model id (default in code).
- `HF_CACHE_DIR` — Where to cache model files (default `./.hf-cache`). On ephemeral disks this is lost between restarts; models re-download on cold start.

## Notes

- **First request** after deploy can be slow while the model loads (and downloads if not cached).
- **Memory:** Loading SmolLM2-360M typically needs around 1–2GB RAM; size the VM/plan accordingly.
- **Standalone:** The image uses Next.js `output: "standalone"` for a smaller build and includes the compiled LLM worker under `dist/llm/`.
