// P0 Step 5C.11 — PublisherProvider abstraction (Facebook-independent first).
//
// One contract for pushing a finished render out of the studio:
//   provider = { kind, target, available(), publish(input) -> { postRef } }
// Targets: PACKAGE (local downloadable folder/zip — always available, no external side effect) and
// FACEBOOK (Draft / Only-Me ONLY; the real adapter needs an enrolled READY account and stays
// PUBLISH_REAL_CERT_PENDING until one exists). Exactly-once is enforced by the CALLER via
// publish_attempts (invocation RESERVED→CONSUMED, submit_state durable BEFORE the irreversible
// step); this module never retries after an uncertain submit and never publishes PUBLIC.

function err(code, message) { return Object.assign(new Error(message), { code }); }

export const PUBLISH_AUDIENCES = Object.freeze(["DRAFT", "ONLY_ME"]);

// ---- PACKAGE publisher (local, deterministic; the "publish" is the package build itself) --------
// buildPackage is injected by the facade (it owns paths + DB correlation); postRef is the package's
// relative zip path — a safe, redacted reference.
export function createPackagePublisherProvider({ buildPackage }) {
  if (typeof buildPackage !== "function") throw err("E_PUBLISHER_CONFIG", "buildPackage is required");
  return Object.freeze({
    kind: "PACKAGE",
    target: "PACKAGE",
    available: () => true,
    async publish({ projectId, renderId = null, onBeforeSubmit = null } = {}) {
      // Building a local package is reversible; the submit fact is still recorded first so the
      // publish attempt life-cycle is identical across targets.
      if (typeof onBeforeSubmit === "function") await onBeforeSubmit();
      const out = await buildPackage({ projectId, renderId });
      return { postRef: out.packageRef || null };
    }
  });
}

// ---- FACEBOOK publisher (guard shell; real actuator injected when a READY account exists) -------
// The actuator contract: async ({ packageDir, caption, audience, onBeforeSubmit }) -> { postRef }.
// It must drive an enrolled persistent profile + fixed proxy session, call onBeforeSubmit() exactly
// once IMMEDIATELY before the single irreversible submit, verify the created draft/post, and return
// a REDACTED postRef. Any unknown outcome must throw with code E_PUBLISH_UNCERTAIN (never retry).
export function createFacebookPublisherProvider({ actuator = null } = {}) {
  return Object.freeze({
    kind: "FACEBOOK",
    target: "FACEBOOK",
    available: () => typeof actuator === "function",
    async publish({ packageDir, caption = "", audience, onBeforeSubmit = null, explicitPublicAuthorization = false } = {}) {
      if (typeof actuator !== "function") {
        throw err("E_PUBLISH_FB_UNAVAILABLE", "No READY Facebook account is enrolled on this runtime");
      }
      // Certification and default operation NEVER post publicly. PUBLIC requires an explicit,
      // caller-supplied human authorization flag AND is still refused here in V1.
      if (!PUBLISH_AUDIENCES.includes(audience)) {
        throw err(audience === "PUBLIC" && !explicitPublicAuthorization
          ? "E_PUBLISH_PUBLIC_FORBIDDEN" : "E_PUBLISH_AUDIENCE", "Only Draft or Only-Me publishing is allowed");
      }
      if (typeof packageDir !== "string" || packageDir.length < 1) throw err("E_PUBLISH_NO_PACKAGE", "A built package is required before publishing");
      const out = await actuator({ packageDir, caption: String(caption ?? "").slice(0, 4000), audience, onBeforeSubmit });
      if (!out || typeof out.postRef !== "string" || out.postRef.length < 1) {
        throw err("E_PUBLISH_UNCERTAIN", "The publish outcome could not be verified; it will not be retried");
      }
      return { postRef: out.postRef.slice(0, 120) };
    }
  });
}
