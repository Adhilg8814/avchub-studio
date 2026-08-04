# Writing a provider plugin

No generation provider ships with this project. The registry starts empty and an installation supplies its
own, because shipping a default would mean shipping an integration with somebody else's service and deciding
on your behalf where you spend money.

This document is the whole contract. It is small on purpose.

## The contract

A plugin is a plain object with a `default` export. Required members:

```js
{
  id: "MYPROVIDER",              // uppercase, stable, appears in every job record

  describe() {                   // what this provider can render, checked BEFORE any spend
    return {
      aspectRatios: ["9:16", "16:9"],
      durationOptions: ["6s", "10s"],
      resolutions: ["720p"]
    };
  },

  async submit({ prompt, plan, accountRef, signal }) {
    return { submissionId: "…", state: "PENDING" };
  },

  async poll(submissionId) {
    return { state: "PENDING" | "SUCCEEDED" | "FAILED" | "REFUSED", failureReason };
  },

  async fetch(submissionId) {
    return { filePath: "/absolute/path/to/the/downloaded/file.mp4" };
  }
}
```

Optional: `prepare(request)` to normalise before submission, and `dispose()` for shutdown.

`assertValidPlugin` in `lib/providers/provider-plugin.mjs` validates all of this at registration, not on the
first job. A half-implemented plugin should fail when you load it, not when a scene is already paid for.

## The four states

| State | Meaning | What the platform does |
|---|---|---|
| `PENDING` | still running | polls again |
| `SUCCEEDED` | a file is available via `fetch()` | downloads, decodes, classifies |
| `FAILED` | the provider tried and could not | records the failure; quota is assumed spent |
| `REFUSED` | the provider declined **before** consuming quota | retryable at no cost |

The distinction between `FAILED` and `REFUSED` is the one that matters. Reporting a refusal as a failure makes
the ledger believe money was spent that was not; reporting a failure as a refusal makes it retry something
that will fail again and charge again. If you are unsure which one happened, return `FAILED` — over-counting
spend is the safer error.

## What the platform will not take your word for

Nothing your plugin says about the result is treated as evidence about the file. After `fetch()` the platform
decodes the file and classifies it with `lib/media/asset-policy.mjs`: resolution tier from the short side,
aspect from the actual dimensions, duration from the container. A plugin that reports 720p and returns 480p
is caught, and the scene is rejected rather than assembled.

This is not distrust of your code. Real providers do accept a 720p request, report it as accepted, and return
480p when an account is over its allowance — with no error anywhere in the exchange.

## Registering it

```bash
AVC_STUDIO_PROVIDER_PLUGINS=/path/to/my-provider.mjs
```

Semicolon- or comma-separated for several. Each module's default export is registered; an import failure names
the path that failed rather than skipping it silently, because a quietly missing provider looks exactly like a
provider outage.

## Testing yours

`lib/providers/mock-provider.mjs` is the reference implementation and the smallest thing that satisfies the
contract — around 80 lines, no network. Copy its shape.

The useful test is not "does submit return an id" but: does the file that comes out of `fetch()` decode to the
plan that went into `submit()`? Feed the result through `classifyGeneratedAsset` and assert the verdict.

## Terms of service

Your plugin, your responsibility. Check that automating your chosen provider is permitted by its terms before
you publish it. This project has no opinion about which services you use and takes no position on your
compliance — but it will not accept a plugin into this repository, whoever writes it.
