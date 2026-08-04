# Contributing

Thank you for looking. This project is maintained by one person, so the most valuable contributions are the ones that need the least back-and-forth to merge.

## Before you start

- For anything larger than a bug fix, **open an issue first**. It costs you ten minutes and can save you a weekend of work in a direction the project will not take.
- Issues labelled `good first issue` are real work with a clear finish line. `help wanted` means the maintainer would genuinely rather someone else did it.
- Writing a **provider plugin** against [`docs/providers.md`](docs/providers.md) is the highest-value contribution right now, and it lives in your own repository — not this one.

## Setting up

```bash
git clone https://github.com/avchub/avchub-studio.git
cd avchub-studio
npm install
cp .env.example .env
npm test
```

`npm test` must pass on a fresh clone with no database and no FFmpeg. If it does not, that is a bug worth reporting on its own.

To run the database-backed suites, point `PGBIN` at a local PostgreSQL `bin` directory. Without it they skip, and a skip is not a failure.

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run scan:secrets
```

All five must pass. CI runs them on Linux and Windows, on Node 20 and 22.

## What a good pull request looks like

**Evidence, not assertion.** "Tests pass" is not evidence; the output is. Say which commands you ran and what they printed. If you fixed a bug, the PR should contain a test that fails without your fix.

**One thing at a time.** A PR that fixes a bug and reformats a file is two PRs. The second one will be reviewed faster on its own.

**Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/): `fix(gateway): ...`, `feat(providers): ...`, `docs: ...`. The subject says what changed; the body says why, and what you verified.

**Match the surrounding code.** This codebase uses plain ESM JavaScript, no build step, no transpilation. Comments explain constraints and decisions that the code cannot show — not what the next line does.

**Never add** a credential, a personal email address, a real hostname, or an absolute path from your machine. `npm run scan:secrets` will catch most of it, but it is not a substitute for looking.

## Review

The maintainer aims to respond to every pull request within **7 days**. A response may be questions rather than a merge decision. If a PR goes quiet for two weeks, please ping it — that is a lapse, not a rejection.

A PR is merged when: it does what it says, it is covered by a test or explains why it cannot be, all checks pass, and it does not expand the project's scope without a prior issue.

## Reporting bugs

Use the issue templates. The single most useful thing you can include is the smallest sequence of commands that reproduces the problem.

## Security

Do not report vulnerabilities through issues or pull requests. See [`SECURITY.md`](SECURITY.md).

## Licensing of contributions

By contributing you agree that your contribution is licensed under [Apache-2.0](LICENSE), the same licence as the project. There is no separate CLA.

## Code of conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
