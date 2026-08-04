# Self-hosting

From a clean machine to a running control plane with demo data.

> This guide has so far only been followed by the person who wrote it, which is the least reliable kind of
> documentation. If a step is wrong or missing, an issue about it is a genuinely useful contribution.

## 1. Prerequisites

| What | Version | Check |
|---|---|---|
| Node.js | ≥ 20 | `node --version` |
| PostgreSQL | ≥ 14, 16 recommended | `psql --version` |
| FFmpeg + ffprobe | any recent build | `ffmpeg -version` |

FFmpeg is **not** bundled — it is GPL and this project does not redistribute it. Install it from
<https://ffmpeg.org/download.html>, your package manager, or Homebrew, and either put it on `PATH` or set
`FFMPEG_PATH` and `FFPROBE_PATH`.

## 2. Get the code

```bash
git clone https://github.com/avchub/avchub-studio.git
cd avchub-studio
npm install
```

`npm install` pulls three runtime dependencies (`pg`, `ws`, `@node-rs/argon2`) and one development dependency.

## 3. Create the roles and the database

Run the two bootstrap templates once, as a superuser, **in this order**. All four roles must exist before the
first migration: migration `0010` grants to `cp_tenant_app`, `cp_ops_enumerator` and `cp_readonly_observer`,
and against a bare superuser database it fails with `undefined_object`.

```bash
psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -v migrator_password="$CP_MIGRATOR_PW" \
  -v tenant_password="$CP_TENANT_PW" \
  -v ops_password="$CP_OPS_PW" \
  -v observer_password="$CP_OBSERVER_PW" \
  -f control-plane/database/bootstrap/roles.sql.template

psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -v db_name=avc_studio \
  -f control-plane/database/bootstrap/database.sql.template
```

The templates contain no passwords — you pass them as psql variables, so nothing secret is written to disk.

The role split is the point, not ceremony. `cp_migrator` owns the schema and is **not** used by the running
service. `cp_tenant_app` is the runtime pool and does **not** bypass row-level security, so a query that
forgets a tenant filter returns nothing rather than someone else's rows. `cp_ops_enumerator` does bypass RLS
for cross-workspace scans and is held to SELECT-only grants. `cp_readonly_observer` reads health and metrics.

The exact same sequence runs in CI against a throwaway container — see `.github/workflows/ci.yml`, which is
the copy that is actually executed on every push and therefore the one that cannot go stale.

## 4. Configure

```bash
cp .env.example .env
```

Fill in at minimum:

```bash
CONTROL_PLANE_DB_URL=postgres://cp_tenant_app:…@127.0.0.1:5432/avc_studio
CONTROL_PLANE_CREDENTIAL_PEPPER=…      # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
CONTROL_PLANE_PAIRING_PEPPER=…         # a different one
AVC_STUDIO_HOME=/path/outside/the/repo
```

Then check it:

```bash
npm run control-plane:check-config
```

This prints a sanitized summary — no secret values — and names anything still missing. It refuses to start in
production mode without a non-loopback host, both peppers, and an allowed-origins list.

**`AVC_STUDIO_HOME` must be outside the working tree.** Media, caches and credentials go there. A data
directory inside the repository ends up in a commit or a `git clean` sooner or later.

## 5. Migrate

The migration credential is **command-only**: it is read from `CONTROL_PLANE_DB_MIGRATION_URL` by this CLI and
nowhere else. The running service's config deliberately refuses to read it, so the process that serves requests
never holds a credential that can alter the schema. Supply it for the command, not in `.env`:

```bash
# scan-secrets:allow documentation example; the password is a shell variable, not a value
CONTROL_PLANE_DB_MIGRATION_URL="postgres://cp_migrator:$CP_MIGRATOR_PW@127.0.0.1:5432/avc_studio" \
  npm run control-plane:db:migrate

# scan-secrets:allow documentation example; the password is a shell variable, not a value
CONTROL_PLANE_DB_MIGRATION_URL="postgres://cp_migrator:$CP_MIGRATOR_PW@127.0.0.1:5432/avc_studio" \
  npm run control-plane:db:status     # state DATABASE_READY, applied == file count
```

Without that variable the CLI stops with `MIGRATION_URL_NOT_SET` rather than falling back to the application
connection — that refusal is the separation working, not a misconfiguration.

Migrations are sequential and forward-only. `control-plane:db:validate` re-checks that what is in the database
matches what the files say.

## 6. Seed the demo

```bash
npm run demo:seed
```

This creates a demo tenant, one project with three scenes, and registers the **mock provider** — which renders
real MP4 files at the requested size and length via your FFmpeg, so the whole pipeline runs end to end without
an account at any generation service.

## 7. Run

```bash
npm run control-plane:dev
```

Then open <http://127.0.0.1:8787>. `/healthz` is liveness, `/readyz` is readiness, `/version` reports the
build.

## 8. Connect a real provider

The mock provider produces solid-colour clips. For real output, write a plugin against
[`providers.md`](providers.md) and point `AVC_STUDIO_PROVIDER_PLUGINS` at it. No provider ships with this
project.

## Running the tests

```bash
npm test                    # no services needed
npm run control-plane:test  # skips cleanly without PostgreSQL
PGBIN=/usr/lib/postgresql/16/bin npm run control-plane:test   # runs for real
```

Database-backed suites create a **disposable cluster** beside the binaries `PGBIN` points at. They refuse to
run against a database whose name does not contain `_test`.

## Production notes

- Put a reverse proxy in front; bind the control plane to loopback. `CONTROL_PLANE_ALLOWED_ORIGINS` must list
  the browser origin you actually serve.
- Back up the database **and** `AVC_STUDIO_HOME` — the database alone does not contain your media.
- Rotating `CONTROL_PLANE_CREDENTIAL_PEPPER` invalidates every worker credential; rotating
  `CONTROL_PLANE_PAIRING_PEPPER` invalidates outstanding pairing codes. Both are recoverable by re-pairing.
- Losing `CONTROL_PLANE_AUTH_SECRETBOX_KEY` makes enrolled TOTP secrets unreadable and every user has to
  re-enrol. Back it up separately from the database.

## Troubleshooting

**`E_FFMPEG_NOT_FOUND`** — ffmpeg or ffprobe is not on `PATH`. Set `FFMPEG_PATH` and `FFPROBE_PATH` to the
executables, not their directory.

**Migrations report pending after they ran** — you are pointed at a different database than you think. Print
the sanitized summary with `npm run control-plane:check-config`.

**Database suites skip** — that is the designed behaviour without `PGBIN`. A skip is not a failure.

**A browser client gets a CORS refusal** — the origin you serve must appear in
`CONTROL_PLANE_ALLOWED_ORIGINS`. This release ships no web UI, so any browser client is one you wrote; it is
subject to the same allowed-origins list as anything else.
