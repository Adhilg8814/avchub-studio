# Control Plane — deployment artifacts (staging-ready, NOT deployed)

These are **inactive design artifacts** for Step 5C.1. Nothing here is built, deployed, or
wired to any VPS / Cloudflare / DNS / process manager. They document how the Control Plane
*would* run in isolation from the existing AVCHub app.

## Files
- `Dockerfile` — non-root, dedicated workdir, exposes only the configured port, includes a
  `HEALTHCHECK` against `/healthz`, handles `SIGTERM` via `main.mjs`. Contains **no secrets**.
- `.dockerignore` — excludes secrets and all provider/browser/Python/UI/media/test code so
  the image contains only the Control Plane + pure `lib/protocol` modules.

## Health checks
- **Liveness** — `GET /healthz` → `200 {status:"ok",alive:true}` (cheap, no dependency
  checks). Container `HEALTHCHECK` and an orchestrator liveness probe use this.
- **Readiness** — `GET /readyz` → `200` only when config is valid, the lifecycle is `READY`,
  and every *enabled* dependency is ready. In skeleton mode (DB/Gateway disabled) it is
  `200`; if an enabled dependency is unavailable it is `503` (`E_DEPENDENCY_NOT_READY`).
  An orchestrator readiness probe uses this to gate traffic and to drain on shutdown.
- **Version** — `GET /version` → safe metadata (service, version, protocolVersion,
  environment, instanceId, commit when configured).

## Resource-limit recommendations (staging skeleton)
- CPU: 0.25–0.5 vCPU; Memory: 128–256 MiB (the skeleton is I/O-light; raise for Gateway/DB
  in later steps).
- Restart policy: on-failure; readiness-gated rollout.
- `--read-only` root filesystem is compatible (the skeleton writes nothing to disk).
- Graceful termination: give the container ≥ `CONTROL_PLANE_SHUTDOWN_TIMEOUT_MS` + margin
  before `SIGKILL`.

## Isolation guarantees
- Separate service/process, config namespace (`CONTROL_PLANE_*`), port, and logs from AVCHub.
- No import of `ui-server`, WorkerRuntime, provider adapters, browser, or Python.
- Binds `127.0.0.1` by default in dev; production requires an explicit non-loopback host.
