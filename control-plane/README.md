# Control Plane (P0 Step 5C.1 — service skeleton)

An **isolated, production-shaped Control Plane service skeleton**. It runs independently of
`ui-server.mjs`, the Studio tunnel, LOCAL_LEGACY, and every provider. This step establishes
structure only — **no business persistence, no Worker execution, no provider access**.

See [docs/p0-step5c1-notes.md](../docs/p0-step5c1-notes.md) for the full design and
[docs/spec-source-of-truth.md](../docs/spec-source-of-truth.md) for the authoritative specs.

## Run
```
npm run control-plane:dev            # bind 127.0.0.1, all flags OFF, no DB, no WSS
npm run control-plane:check-config   # validate env, print sanitized summary, exit 0/1
npm run control-plane:test           # Step 5C.1 + 5C.2 test suites (ephemeral ports; DB tests skip w/o a *_test DB)
```

## Database (Step 5C.2 — PostgreSQL; not deployed here)
```
# One-time bootstrap (DBA/superuser): create roles + database (no secrets in repo — psql :vars)
psql -v migrator_password=… -v tenant_password=… -v ops_password=… -v observer_password=… \
     -f control-plane/database/bootstrap/roles.sql.template
psql -v db_name=controlplane -f control-plane/database/bootstrap/database.sql.template

# Migrations (command-only; uses CONTROL_PLANE_DB_MIGRATION_URL — never the running service)
npm run control-plane:db:status      # applied vs pending + schema state
npm run control-plane:db:migrate     # apply pending (advisory-locked, txn/migration, checksum-tracked)
npm run control-plane:db:validate    # checksum-verify + classify (no apply)
npm run control-plane:db:reset:test  # DROP+recreate schema of a verified *_test DB only

# Live integration tests need: CONTROL_PLANE_TEST_DB_URL (loopback, name has _test),
#   CONTROL_PLANE_DB_MIGRATION_URL, CONTROL_PLANE_DB_OPS_URL, CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS=true
npm run test-step5c2
```
Normal service startup **never** migrates. See [../docs/p0-step5c2-notes.md](../docs/p0-step5c2-notes.md).
Config is `CONTROL_PLANE_*` env vars — see [config/.env.example](config/.env.example). The
loader is the ONLY place the environment is read.

## Endpoints
- `GET /healthz` — liveness (fast, no dependency checks).
- `GET /readyz` — readiness (config valid + lifecycle READY + enabled deps ready).
- `GET /version` — safe metadata only.
- `GET /internal/config-summary` — dev/test only; sanitized, non-secret metadata.

## Module boundaries (modular monolith)
```
main.mjs → app.mjs (composition root + lifecycle)
  ├─ config/            validated, injected-once configuration (only env reader)
  ├─ logging/           structured JSON logger + redaction
  ├─ feature-flags/     evaluator (all OFF by default; no real execution this step)
  ├─ persistence/       PostgreSQL adapter + repositories + ownership/session transactions (5C.2/5C.4)
  ├─ gateway/           real WebSocket Worker Gateway (5C.4; auth · HELLO · sessions · delivery adapter)
  ├─ processor/         transactional inbox/outbox processor (5C.3; delivery via the Gateway adapter)
  ├─ health/            component health/readiness registry
  ├─ api/               http-server · router · request-context · responses · errors
  └─ security/          identity/actor placeholder (no human auth yet)
```
The core imports only **pure** `lib/protocol/*` value modules. A dependency-boundary test
(`boundary.mjs`) fails if any core file imports `ui-server`, WorkerRuntime, provider
adapters, the local simulator, browser, or Python code.

## Guarantees
- All execution/paid feature flags default **OFF**; no flag can enable real provider
  execution in this step.
- Enabling DB/Gateway/Processor before their implementation fails **safely** (readiness
  `false`, never a fake production dependency).
- Public errors carry `{code, message, retriable, correlationId}` — never a stack trace.
- Graceful drain + shutdown; no leaked sockets or timers.
