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

## 3. Create the database

```sql
CREATE DATABASE avc_studio;
CREATE ROLE cp_tenant_app LOGIN PASSWORD 'choose-something-long';
GRANT CONNECT ON DATABASE avc_studio TO cp_tenant_app;
```

`control-plane/database/bootstrap/roles.sql.template` defines the full role set — a migrator, an application
role that does **not** bypass row-level security, an ops enumerator that does, and a read-only observer. For a
single-operator install the application role alone is enough to start.

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

```bash
npm run control-plane:db:migrate
npm run control-plane:db:status     # should report 44 applied, 0 pending
```

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

**The UI loads but shows nothing** — the API is on the same origin as the page. If you put it behind a proxy,
the browser origin must appear in `CONTROL_PLANE_ALLOWED_ORIGINS`.
