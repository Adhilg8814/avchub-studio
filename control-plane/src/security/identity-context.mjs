// P0 Step 5C.1 — request identity / actor placeholder.
//
// Human authentication is NOT implemented in this step. This module ONLY provides an
// explicit "unauthenticated" actor so no code can accidentally pretend a user is
// authenticated. Routes that will require authentication must remain unavailable /
// E_NOT_IMPLEMENTED until the auth layer lands (a later step).

export const ACTOR_TYPES = Object.freeze({
  ANONYMOUS: "ANONYMOUS",     // no authenticated principal
  USER: "USER",               // (future) human session
  WORKER: "WORKER",           // (future) paired worker
  PLATFORM_OPERATOR: "PLATFORM_OPERATOR", // (future) admin
  SYSTEM: "SYSTEM"            // internal
});

// The only actor this step ever produces.
export function anonymousActor() {
  return Object.freeze({ type: ACTOR_TYPES.ANONYMOUS, id: null, authenticated: false });
}

// requireAuthenticated(): a guard for future authenticated routes. In this step it always
// signals "not implemented" so no route can silently treat a request as authenticated.
export function requireAuthenticated() {
  const err = new Error("Authentication is not implemented in Step 5C.1");
  err.code = "E_NOT_IMPLEMENTED";
  throw err;
}
