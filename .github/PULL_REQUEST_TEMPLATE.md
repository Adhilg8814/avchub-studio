## What this changes

<!-- One paragraph. What behaviour is different after this PR? -->

## Why

<!-- The problem. Link the issue if there is one. -->

## How it was verified

<!-- Which commands you ran and what they printed. "Tests pass" is not evidence; the output is. -->

```
npm test
```

## Checklist

- [ ] `npm test` passes
- [ ] `npm run lint && npm run typecheck && npm run build` pass
- [ ] `npm run scan:secrets` is clean
- [ ] No credential, personal data, hostname or absolute machine path added
- [ ] Behaviour change is covered by a test, or the PR explains why it cannot be
- [ ] Docs updated if the change is user-visible
