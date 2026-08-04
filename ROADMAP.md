# Roadmap

What this project intends to do next, in the order it intends to do it. Dates are targets, not commitments —
this is a single-maintainer project. Anything here is open to a contributor; comment on the issue first.

Items marked **help wanted** are ones the maintainer would rather someone else did, usually because they need
a platform or a perspective the maintainer does not have.

## Now — towards 0.2

| Item | Why it matters |
|---|---|
| **Cross-platform credential store** — **help wanted** | The store is Windows DPAPI only. macOS Keychain and libsecret implementations would make the project usable outside Windows without writing your own. |
| **A second provider plugin** — **help wanted** | The plugin contract has exactly one implementation (the mock). Until someone writes a real one against it, we do not know if the contract is right. |
| **Database suites in CI** | The PostgreSQL job exists in the workflow but the suites need their setup documented and their skips audited so a red run means something. |
| **`docs/self-hosting.md` verified on a clean machine** | It has only ever been followed by its author, which is the least reliable kind of documentation. |

### A public operator console — **help wanted**

The console this project is driven with privately is not published: provider account enrollment, proxy
management and tunnel management are woven through it, and those stay private. Splitting out the pages that
do not touch any of that — stories, movies, workers, platform — is a real piece of work and a good one for
someone who likes front-end. The HTTP API it would talk to is already public.

## Next — towards 0.3

- Split the tree into `apps/` and `packages/` so the protocol and the media policy can be published separately.
- Publish `@avchub/protocol` to npm once its interface has survived a second implementation.
- TypeScript definitions, or `checkJs` with a jsconfig, replacing the current static checks.
- An OpenAPI description of the control-plane HTTP surface.
- Structured metrics (job latency, provider spend, failure classes) with a Prometheus endpoint.

## Later

- Container images and a `docker compose` quick start.
- A worker distributable for people who do not want to run from source.
- Horizontal scaling: more than one control-plane instance against one database.

## Explicitly not planned

- **Bundled generation providers.** Anything that drives a third-party web interface stays out of this
  project, whoever writes it.
- **A hosted service.** This is software you run.
- **Bundled FFmpeg binaries.** Licence obligations this project is not set up to meet.

## How to influence this

Open an issue describing the problem you have. A roadmap item backed by someone who actually hit the problem
moves ahead of one that is only a good idea.
