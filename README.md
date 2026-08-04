# AVCHub Studio

**Self-hosted control plane for AI video production: an exactly-once job ledger, a documented remote-worker protocol, TTS narration, subtitle alignment and FFmpeg assembly, with pluggable providers.**

> **Status: v0.1.0 — a headless control plane.** This release is a backend: an HTTP API, a worker protocol,
> the orchestration around them, a media pipeline, and a mock provider. **There is no web dashboard in this
> release.** You drive it through its API.
>
> The code has run a private studio daily, but it has had exactly one operator. Expect rough edges in setup,
> and please open an issue when you hit one — that is the most useful thing you can contribute right now.

### What this release is, in one screen

| | |
|---|---|
| **Ships** | HTTP API · remote-worker protocol and gateway · job orchestration with exactly-once provider accounting · media pipeline (narration, subtitle alignment, FFmpeg assembly) · story pipeline · provider plugin contract and registry · **mock provider** · PostgreSQL schema with row-level tenant isolation · native auth |
| **Does not ship** | **A web dashboard** — planned, see [ROADMAP](ROADMAP.md) · any commercial generation provider · any browser automation of a third-party service · FFmpeg itself |
| **You supply** | PostgreSQL · FFmpeg · a provider plugin, if you want real generated video · a UI, if you want one before we build it |

The **mock provider** exists to run the whole pipeline end to end — plan, submit, poll, fetch, decode,
classify, assemble — **without producing content at any commercial service**. It renders solid-colour clips
through your local FFmpeg, costs nothing, and makes no network call.

Both extension points are public contracts: write a **provider plugin** against
[`docs/providers.md`](docs/providers.md), or a **UI** against the HTTP API. Neither requires anything from us.

> Everything runs on your own machine against your own PostgreSQL. Nothing connects to a hosted AVCHub
> service, and there is no account to create.

## What problem it solves

Turning a script into a finished narrated video with AI means gluing together a generation provider, a speech provider, and FFmpeg. Doing that once is a weekend. Doing it repeatedly, on your own hardware, without losing money is a different problem:

- **Paid generation is not idempotent.** A crash between "submitted" and "recorded" either loses the clip you paid for or buys it twice. AVCHub Studio keeps a PostgreSQL job ledger where every provider invocation is recorded before it happens and settled exactly once.
- **Providers report success they did not deliver.** A provider can accept a 720p request, report it as accepted, and return 480p. Every acceptance check here reads the **decoded file**, never the provider's own account of it (`lib/media/asset-policy.mjs`).
- **Long jobs outlive processes.** Workers reconnect, resume, and reconcile against a recovery journal rather than starting over.
- **Credentials on a single-operator machine.** Secrets live outside the repository, encrypted at rest, and the config loader refuses to start if a secret-shaped value appears in a config file.

## What ships, and what does not

**No AI generation provider ships with this project.** The provider registry starts empty. Nothing here calls
a generation service, holds an account, or knows how to sign in to one — and adding such an integration to
this repository is out of scope, whoever writes it.

Specifically, this project contains **no browser automation of any third-party service**: no scripted sign-in,
no driving of somebody else's web interface, no session or cookie handling for an external account. If you
want real generated video you write a provider plugin against a service's **official API**, under whatever
terms that service sets, and load it from your own repository.

What ships instead is a **mock provider** (`lib/providers/mock-provider.mjs`, about 80 lines). It renders a
solid-colour MP4 through your local FFmpeg at exactly the aspect ratio, resolution and duration that were
requested. It makes no network call and costs nothing.

That sounds like a toy, and it is not the point. The mock exists so the part this project actually is — the
orchestration — can be run and verified for real:

- a job is planned, recorded in the ledger, submitted, polled, fetched and settled **exactly once**;
- the returned file is **decoded and measured**, then classified against what was asked for, so the acceptance
  path is exercised against a genuine file rather than a stub that would make every verdict meaningless;
- a scene that fails the source gate is rejected instead of assembled;
- narration, subtitle alignment and FFmpeg assembly run over the result.

`npm run demo:seed` does exactly this and prints the verdict per scene. If the orchestration is broken, you
find out without spending anything at a provider.

The demo needs **no account anywhere, no hosted service, and no credential**. Its story, characters and
scenes are invented for the file you can read at `scripts/demo/seed-demo.mjs`; it writes only into your own
data directory. There is no default credential in this repository and nothing to revoke if you delete it.

### Bringing your own provider

A provider is a plain object with five members — `id`, `describe()`, `submit()`, `poll()`, `fetch()` — validated
at registration rather than on the first paid job. Point `AVC_STUDIO_PROVIDER_PLUGINS` at your module and the
registry loads it:

```bash
AVC_STUDIO_PROVIDER_PLUGINS=/path/to/my-provider.mjs
```

The full contract, the four submission states, and what the platform will *not* take your word for are in
[`docs/providers.md`](docs/providers.md). The mock is the reference implementation — copy its shape.

Your plugin lives in your own repository, and checking that automating your chosen service is permitted by its
terms is your responsibility.

## Features

| Area | What is there |
|---|---|
| Job ledger | PostgreSQL, 44 sequential migrations, row-level security, per-tenant isolation |
| Worker protocol | Documented envelope + state machine (`docs/protocol-v1.md`), WebSocket gateway, heartbeat, resume |
| Recovery | Journal-based crash recovery with a written contract (`docs/recovery-contract.md`) |
| Auth | Argon2id passwords, TOTP, recovery codes, sessions, a policy-decision endpoint and a fail-closed gateway |
| Media | FFmpeg assembly, audio timeline, subtitle alignment, contact sheets, mastering to a target loudness and sample rate |
| Story | Structure planning, quality scorecard, repetition and continuity checks |
| Providers | Plugin contract, registry, mock provider, ElevenLabs **official API** adapter |

### Why there is no dashboard yet

The console this system is driven with privately is not published, and will not be: provider account
enrollment, proxy management and tunnel management run through it, and those stay private. Rather than ship
half of it, 0.1.0 ships the API it talks to. A public UI is a planned, separate piece of work — see
[ROADMAP](ROADMAP.md), where it is flagged `help wanted`.

## Requirements

- **Node.js ≥ 20**
- **PostgreSQL ≥ 14** (16 recommended)
- **FFmpeg and ffprobe — you install these yourself.** They are **not** bundled and never downloaded by
  `npm install`. FFmpeg is GPL; redistributing it carries obligations this project is not set up to meet, so
  it is invoked, not shipped. Get it from <https://ffmpeg.org/download.html> or your package manager, then put
  it on `PATH` or set `FFMPEG_PATH` and `FFPROBE_PATH`. Without it, rendering and the demo will refuse to run
  with a named error rather than degrade silently.
- Windows, macOS or Linux. The credential store uses Windows DPAPI; on other platforms supply your own store implementation.

## Quick start

```bash
git clone https://github.com/avchub/avchub-studio.git
cd avchub-studio
npm install

cp .env.example .env          # then edit CONTROL_PLANE_DB_URL and the two peppers
npm run control-plane:db:migrate
npm run demo:seed             # a demo tenant, one project, three scenes, the mock provider
npm run control-plane:dev     # http://127.0.0.1:8787
```

`npm run control-plane:check-config` prints a sanitized summary and tells you which variables are still missing. Full walkthrough: [`docs/self-hosting.md`](docs/self-hosting.md).

## Configuration

Everything is environment-driven; [`.env.example`](.env.example) lists every variable with a comment. The ones you cannot skip:

| Variable | Purpose |
|---|---|
| `CONTROL_PLANE_DB_URL` | PostgreSQL connection for the application role |
| `CONTROL_PLANE_CREDENTIAL_PEPPER` | Server-side pepper for worker credentials |
| `CONTROL_PLANE_PAIRING_PEPPER` | Server-side pepper for pairing codes |
| `AVC_STUDIO_HOME` | Writable data directory, kept **outside** the repository |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Only if FFmpeg is not on `PATH` |
| `AVC_STUDIO_PROVIDER_PLUGINS` | Paths to your provider plugins; empty means mock only |

No secret belongs in a config file. The loader rejects config values that look like credentials.

## Tests and build

```bash
npm test                      # unit suites, no services required
npm run test-protocol         # protocol contract
npm run test-recovery         # recovery contract and properties
npm run control-plane:test    # control plane, skips cleanly without PostgreSQL
npm run lint && npm run typecheck && npm run build
npm run scan:secrets          # refuses secret-shaped content in the tree
```

Database-backed suites **skip** rather than fail when PostgreSQL is absent, so a fresh clone is green. Point `PGBIN` at a local PostgreSQL `bin` directory to run them for real.

## Architecture

```
control-plane/          HTTP + WebSocket gateway, background processor, persistence, auth
  src/api/              routing and request context
  src/gateway/          worker WebSocket gateway (bearer credential, heartbeat, resume)
  src/processor/        outbox, inbox, retries, reconciliation, settlement
  src/persistence/      PostgreSQL adapter, 44 migrations, repositories
  src/auth/             Argon2id + TOTP, sessions, policy decision endpoint
lib/protocol/           the worker wire contract, shared by both sides
lib/worker/             worker runtime: transport, recovery journal, credential store
lib/media/              asset policy and FFmpeg location
lib/movie/              assembly, audio timeline, subtitles, mastering
lib/story/              structure, quality scoring, continuity
lib/providers/          plugin contract, registry, mock provider
lib/ops/                gateway, backup/restore, release packaging, license audit
```

More detail in [`ARCHITECTURE.md`](ARCHITECTURE.md); the wire format is specified in [`docs/protocol-v1.md`](docs/protocol-v1.md).

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). Issues labelled `good first issue` are real work, not busywork. Writing a provider plugin against [`docs/providers.md`](docs/providers.md) is the highest-value contribution today.

## Roadmap

[`ROADMAP.md`](ROADMAP.md) — near-term: a non-Windows credential store, a provider plugin written by someone other than the author, and getting the database-backed suites running in CI.

## Security

Please report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md). Do not open a public issue for a vulnerability.

## Provenance

This repository began as a sanitized, independently buildable snapshot of a larger private codebase. The
earlier private history was deliberately not imported: it records deployment-specific operational detail that
has no place in a public repository, and rewriting it selectively would be less trustworthy than starting
clean. Development from that first public commit onward is carried out here normally, in the open.

The snapshot was assembled from an explicit allow-list — copying in what belongs here, rather than copying
everything and then deleting — so anything not on the list never arrived in the first place. What stayed
behind is private by design (the provider integrations and the account, proxy and credential management around
them), specific to one deployment (its operational tooling and runbooks), or superseded.

Nothing here depends on any of it. The tree builds, tests and runs its demo on its own, which is the property
that actually matters — and the one CI verifies on every commit.

## License

[Apache-2.0](LICENSE). Third-party components are inventoried in [`NOTICE`](NOTICE) and `docs/THIRD_PARTY_NOTICES.md`.
