# Architecture

The shape of the system and, where it matters, why it is that shape.

## The one idea

Every paid provider invocation is written to a durable ledger **before** it happens and settled **exactly
once** afterwards. Everything else — the worker protocol, the recovery journal, the acceptance checks — exists
to keep that true across crashes, reconnects and providers that lie about what they delivered.

Two failure modes drive the design:

1. **A crash between "submitted" and "recorded"** either loses a clip you paid for or buys it twice. The
   ledger records intent first, so recovery can always tell which happened.
2. **A provider reports success it did not deliver.** Acceptance is therefore decided by decoding the file,
   never by what the provider said about it.

## Processes

```
                 API client
                       │  https
                 ┌─────▼──────┐
                 │  gateway   │  lib/ops/studio-gateway.mjs
                 │  (PEP)     │  fail-closed reverse proxy; asks the PDP before forwarding
                 └─────┬──────┘
                       │  loopback, signed with a per-installation secret
        ┌──────────────▼───────────────┐
        │        control plane          │  control-plane/src/main.mjs
        │  api · gateway · processor    │
        │  persistence · auth           │
        └──────┬─────────────────┬──────┘
               │ SQL             │ WebSocket (bearer credential)
        ┌──────▼──────┐   ┌──────▼───────┐
        │ PostgreSQL  │   │   worker(s)  │  lib/worker/
        │ RLS, 44     │   │  local or    │
        │ migrations  │   │  remote      │
        └─────────────┘   └──────┬───────┘
                                 │ plugin interface
                          ┌──────▼───────┐
                          │  provider    │  supplied by the operator; none ships here
                          └──────────────┘
```

## Components

### control-plane/src

| Directory | Responsibility |
|---|---|
| `main.mjs`, `app.mjs` | Entry point and composition root. All wiring is explicit; there is no service locator. |
| `api/` | HTTP router, request context, response shaping. Sub-routers are consulted in a fixed order. |
| `gateway/` | The worker WebSocket gateway: origin check, bearer credential verification against a peppered HMAC, heartbeat, resume after reconnect. |
| `processor/` | Background work: outbox delivery, inbox, offer expiry, reconciliation, retention, retry policy, settlement. |
| `persistence/` | PostgreSQL adapter, migration runner, 14 repositories, transaction ownership helpers. |
| `auth/` | Argon2id, TOTP, sessions, and the policy decision endpoint the gateway calls. |
| `api-staging/` | The business API: projects, generation, movies, story factory. |
| _(web UI)_ | Not part of this release — see README. The control plane serves an HTTP API; `app.mjs` mounts a UI sub-router only if one is present. |
| `boundary.mjs` | An import firewall. It fails the test suite if the control plane imports a worker, a provider or the legacy pipeline. The separation is enforced, not merely intended. |

### lib

| Package | Responsibility |
|---|---|
| `protocol/` | The wire contract both sides depend on: envelope, message types, job states, transitions, error codes, trusted header names. Specified in `docs/protocol-v1.md`. |
| `worker/` | Worker runtime: transport, recovery journal and classifier, pending-ack store, job registry, credential store, pairing client, remote fleet. |
| `providers/` | The plugin contract, the registry (empty by default), and the mock provider. |
| `media/` | `asset-policy.mjs` — what was asked for versus what the decoded file is. `ffmpeg-locator.mjs` — where FFmpeg is. |
| `movie/` | Assembly, audio timeline, subtitles, mastering, vision judging, packaging. |
| `story/` | Structure, quality scorecard, repetition and continuity detection. |
| `auth/` | Password hashing, TOTP, recovery codes, sealed secrets. |
| `ops/` | Gateway, backup/restore, release packaging, license audit, structured logging. |

## Scene count follows content, not duration

Worth knowing before you wonder why a 60-second target produced one scene: **the number of scenes comes from
the story's beats.** Duration decides how long each scene is, never how many there are.

A story with no beats becomes exactly one scene built from its synopsis. Earlier the planner padded thin
stories up to a three-scene minimum by repeating beats — which produced several identical shots and spent a
paid generation on each. A caller that genuinely wants padding asks for it with `padToMinimum`, and gets
repeated beats because that is what was requested. More beats than `MAX_SCENES` are truncated, not merged.

Implemented in `lib/movie/scene-planner.mjs`; the contract is asserted in `tests/step5c10-story-scene-tests.mjs`.

## Data

PostgreSQL, 44 sequential forward-only migrations in `control-plane/database/migrations`. Multi-tenancy is
enforced by **row-level security**, not by application code alone: the application role does not bypass RLS,
so a query that forgets a tenant filter returns nothing rather than someone else's rows. A separate ops role
with `BYPASSRLS` exists for administrative enumeration, and a read-only observer role for inspection.

## Trust boundaries

1. **Browser → gateway.** Public. Everything is untrusted.
2. **Gateway → control plane.** Loopback. The gateway stamps `x-avc-gateway*` headers carrying its
   policy decision; every inbound copy of those headers is stripped first, so a browser can never supply one.
   Names live in `lib/protocol/trusted-headers.mjs` because both sides must agree exactly.
3. **Worker → gateway.** Authenticated with a bearer credential verified against a peppered HMAC. The
   plaintext credential exists only during a handshake.
4. **Worker → provider plugin.** In-process, full privileges. Only load plugins you trust.

## What is deliberately absent

- **Any generation provider.** See `docs/providers.md`.
- **A browser application.** The operator console used privately is not in this release; provider account,
  proxy and tunnel management run through it. `app.mjs` mounts a UI sub-router only when one is present.
- **A bundled FFmpeg.** It is GPL; the operator installs it and the locator finds it.
- **A build step.** The control plane is ESM run directly by Node. There is no bundler to misconfigure and no
  build output to go stale.
- **A framework.** The HTTP layer is `node:http` and a router. This is a long-lived single-operator service,
  and the dependency surface is the thing most likely to break it over years.

## Reading order

`docs/protocol-v1.md` for the wire format, `docs/recovery-contract.md` for what happens after a crash,
`control-plane/src/app.mjs` to see how it is all wired together.
