// P0 Step 5C.3 — offer-expiry sweep. Enumerates LIVE, unaccepted, expired offers (ops READ ONLY)
// and resolves each through the Step 5C.2 ownership logic. The decision is per-offer and locked,
// so two sweeps produce exactly ONE replacement. It NEVER re-offers a possibly-delivered offer.

import * as OWN from "../persistence/transactions/ownership.mjs";

export function createOfferExpiryProcessor({ adapter, clock, config, logger }) {
  const batchSize = config.batchSize;

  async function enumerateExpired() {
    if (!adapter.opsEnumerate) return [];
    const r = await adapter.opsEnumerate((c) => c.query(
      `SELECT workspace_id, id FROM job_offers
        WHERE offer_expires_at <= now() AND accepted_at IS NULL AND ownership_status='OFFERED'
        ORDER BY offer_expires_at LIMIT $1`, [batchSize]));
    return r.rows;
  }

  async function runOnce({ signal } = {}) {
    const stats = { expired: 0, reoffered: 0, recovering: 0, skipped: 0 };
    const due = await enumerateExpired();
    for (const row of due) {
      if (signal && signal.aborted) break;
      stats.expired += 1;
      let res;
      try {
        // nowMs omitted: the enumeration already selected offers expired per the DB clock, so
        // expireOfferCore re-validates liveness by ownership_status (race-safe) without a JS clock.
        res = await adapter.tenantTransaction(row.workspace_id, (c) => OWN.expireOfferCore(c, { workspaceId: row.workspace_id, offerId: row.id }));
      } catch (e) {
        stats.skipped += 1;
        logger?.debug?.("offer_expiry_error", { component: "processor", event: "offer_expiry_error", reasonCode: (e && e.code) || "ERROR" });
        continue;
      }
      if (res.reoffered) stats.reoffered += 1;
      else if (res.recovering) stats.recovering += 1;
      else stats.skipped += 1;
    }
    return stats;
  }

  return { runOnce, _enumerateExpired: enumerateExpired };
}
