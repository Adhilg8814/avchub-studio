// AVC Studio P0 Step 5B — Worker installation identity (PURE, non-secret).
//
// An opaque random id created once per install. NOT a hardware fingerprint (no disk/
// MAC/motherboard/browser identifiers) and NOT an authentication factor — a stolen
// installationId alone cannot authenticate. The Control Plane assigns workerId.

import { generateInstallationId } from "../control/identity-crypto.mjs";

export function newInstallationId() { return generateInstallationId(); }

// getOrCreateInstallationId(store): reads a persisted non-secret installation id or
// creates one. `store` is any { getInstallationId(), setInstallationId(id) } (e.g. a
// small JSON metadata file, distinct from the encrypted credential store).
export function getOrCreateInstallationId(store) {
  let id = store && typeof store.getInstallationId === "function" ? store.getInstallationId() : null;
  if (!id) { id = newInstallationId(); if (store && typeof store.setInstallationId === "function") store.setInstallationId(id); }
  return id;
}
