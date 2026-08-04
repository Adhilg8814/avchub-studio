# Third-party notices — AVCHub Studio

> Generated offline by `node scripts/ops/license-audit.mjs` from package.json + node_modules.
> No distribution blocker found: every bundled dependency is permissively licensed, and FFmpeg is invoked rather than bundled.

## npm packages

| Package | Version | License | Section | Flags |
|---|---|---|---|---|
| @node-rs/argon2 | 2.0.2 | MIT | dependencies | — |
| pg | 8.22.0 | MIT | dependencies | — |
| playwright-core | 1.61.1 | Apache-2.0 | devDependencies | — |
| ws | 8.21.0 | MIT | dependencies | — |

## Non-npm components

### FFmpeg / ffprobe
- License: LGPL-2.1-or-later or GPL-2.0-or-later, depending on the build
- Distribution risk: NONE · Status: OK
- INVOKED, never bundled and never redistributed. The operator installs FFmpeg themselves and the locator finds it via FFMPEG_PATH, an optional static package they added, or PATH. Not depending on it is what makes this project distributable.

### PostgreSQL
- License: PostgreSQL License (permissive)
- Distribution risk: NONE · Status: OK
- Connected to over the network with operator-supplied credentials; no binary is bundled.

## Flags requiring attention

- none

_No legal approval is implied by this document; it is an inventory._
