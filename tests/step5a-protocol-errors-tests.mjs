#!/usr/bin/env node
// P0 Step 5A — protocol error handling over a REAL local WebSocket. Uses a raw ws
// client sending crafted frames; asserts the documented ERROR codes / close policy.
// No stack trace is ever sent over the wire. Localhost only, no provider/quota.

import { generateId, waitFor, tick, startPlane, makeIdentity, rawConnect } from "./helpers/step5a-harness.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";

let unhandled = false;
process.on("unhandledRejection", (err) => { unhandled = true; console.error("UNHANDLED REJECTION:", err && err.message); });

let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
const errorsOf = (raw) => raw.messages.filter((m) => m.type === "ERROR");
const acksOf = (raw) => raw.messages.filter((m) => m.type === "MESSAGE_ACK");

const id = makeIdentity("E");
const setup = await startPlane({ credentials: { [id.credential]: { workerId: id.workerId, workspaceId: id.workspaceId } } });
const { plane } = setup;
const raws = [];
function connectRaw(cred = id.credential) { const r = rawConnect(plane.port, { authorization: cred ? `Bearer ${cred}` : undefined }); raws.push(r); return r; }
// Build a base worker→cloud envelope with the connection's identity.
function baseEnv(over = {}) {
  const env = makeEnvelope({ type: "WORKER_HEARTBEAT", workspaceId: id.workspaceId, workerId: id.workerId, payload: { activeJobs: [], freeBytes: 1 } });
  return { ...env, ...over };
}

try {
  // 1. bad credential → handshake rejected (401)
  {
    const raw = connectRaw("wrong-credential");
    let ok = false; try { await raw.open(); ok = true; } catch { /* rejected */ }
    check("1 bad credential rejected at handshake", ok, false);
    check("1 handshake status 401", raw.unexpected[0], 401);
  }
  // 2. missing Authorization header → 401
  {
    const raw = connectRaw(null);
    let ok = false; try { await raw.open(); ok = true; } catch { /* rejected */ }
    check("2 missing header rejected", ok, false);
    check("2 audit auth_rejected recorded", plane.getAudit().some((a) => a.type === "auth_rejected"), true);
  }
  // 3. credential in HELLO payload is IGNORED (server uses connection identity)
  {
    const raw = connectRaw(); await raw.open();
    raw.send(makeEnvelope({ type: "WORKER_HELLO", workspaceId: id.workspaceId, workerId: id.workerId, payload: { workerVersion: "0.1.0", platform: "test", protocolVersion: 1, capabilities: ["grok.video"], credential: "sneaky-secret-xyz" } }));
    await waitFor(() => raw.messages.some((m) => m.type === "HELLO_ACK"));
    check("3 HELLO with payload credential still acked (credential ignored)", raw.messages.some((m) => m.type === "HELLO_ACK"), true);
    check("3 payload credential never logged", JSON.stringify(plane.getAudit()).includes("sneaky-secret-xyz"), false);
  }
  // 4. protocol-version mismatch
  {
    const raw = connectRaw(); await raw.open();
    raw.send(baseEnv({ protocolVersion: 2 }));
    await waitFor(() => errorsOf(raw).length > 0);
    check("4 protocol-version mismatch → E_PROTOCOL_VERSION", errorsOf(raw)[0]?.payload.code, "E_PROTOCOL_VERSION");
  }
  // 5. invalid ULID
  {
    const raw = connectRaw(); await raw.open();
    raw.send(baseEnv({ messageId: "not-a-ulid" }));
    await waitFor(() => errorsOf(raw).length > 0);
    check("5 invalid ULID → E_INVALID_ID", errorsOf(raw)[0]?.payload.code, "E_INVALID_ID");
  }
  // 6. timestamp skew
  {
    const raw = connectRaw(); await raw.open();
    raw.send(baseEnv({ sentAt: "2000-01-01T00:00:00.000Z" }));
    await waitFor(() => errorsOf(raw).length > 0);
    check("6 timestamp skew → E_TIMESTAMP_SKEW", errorsOf(raw)[0]?.payload.code, "E_TIMESTAMP_SKEW");
  }
  // 7. oversized payload
  {
    const raw = connectRaw(); await raw.open();
    const big = "x".repeat(300 * 1024);
    raw.send(baseEnv({ payload: { activeJobs: [], blob: big } }));
    await waitFor(() => errorsOf(raw).length > 0);
    check("7 oversized payload → E_PAYLOAD_TOO_LARGE", errorsOf(raw)[0]?.payload.code, "E_PAYLOAD_TOO_LARGE");
  }
  // 8. invalid direction (worker sends a cloud→worker type)
  {
    const raw = connectRaw(); await raw.open();
    raw.send(makeEnvelope({ type: "JOB_OFFER", workspaceId: id.workspaceId, workerId: id.workerId, jobId: generateId("job"), payload: { action: "STORAGE_SCAN", input: {} } }));
    await waitFor(() => errorsOf(raw).length > 0);
    check("8 wrong direction → ERROR", errorsOf(raw)[0]?.payload.code, "E_INVALID_ENVELOPE");
  }
  // 9a. worker identity mismatch → E_IDENTITY_MISMATCH (message rejected, connection kept)
  {
    const raw = connectRaw(); await raw.open();
    raw.send(baseEnv({ workerId: generateId("wrk") }));
    await waitFor(() => errorsOf(raw).length > 0);
    check("9 worker identity mismatch → E_IDENTITY_MISMATCH", errorsOf(raw)[0]?.payload.code, "E_IDENTITY_MISMATCH");
  }
  // 9b. workspace mismatch → severe → connection closed
  {
    const raw = connectRaw(); await raw.open();
    raw.send(baseEnv({ workspaceId: generateId("ws") }));
    await waitFor(() => raw.closes.length > 0 || errorsOf(raw).length > 0);
    check("9 workspace mismatch → E_IDENTITY_MISMATCH", errorsOf(raw).some((e) => e.payload.code === "E_IDENTITY_MISMATCH"), true);
    await waitFor(() => raw.closes.length > 0);
    check("9 workspace mismatch closes connection (severe)", raw.closes.length > 0, true);
  }
  // 10. duplicate messageId → deduped (cached ACK replayed, not re-processed)
  {
    const raw = connectRaw(); await raw.open();
    const rec = makeEnvelope({ type: "STATE_RECONCILE", workspaceId: id.workspaceId, workerId: id.workerId, payload: { reconcileId: generateId("corr"), index: 0, total: 1, isLast: true, items: [], counts: { terminalPendingAck: 0, activeJobs: 0 } } });
    raw.send(rec);
    await waitFor(() => acksOf(raw).length >= 1);
    raw.send(rec); // exact duplicate (same messageId)
    await waitFor(() => acksOf(raw).length >= 2);
    check("10 duplicate messageId → cached ACK replayed", acksOf(raw).length >= 2, true);
    check("10 both ACKs reference same message", acksOf(raw)[0].payload.ackedMessageId === acksOf(raw)[1].payload.ackedMessageId, true);
  }
  // 11. malformed JSON → dropped, connection survives, no crash
  {
    const raw = connectRaw(); await raw.open();
    raw.ws.send("this is not json {");
    await tick(30);
    check("11 malformed JSON audited", plane.getAudit().some((a) => a.type === "malformed_json"), true);
    check("11 connection survived malformed frame", raw.ws.readyState, 1);
  }
  // 12. unknown message type
  {
    const raw = connectRaw(); await raw.open();
    raw.send(baseEnv({ type: "FROBNICATE" }));
    await waitFor(() => errorsOf(raw).length > 0);
    check("12 unknown type → E_UNKNOWN_TYPE", errorsOf(raw)[0]?.payload.code, "E_UNKNOWN_TYPE");
  }
  // 13. ACK loop attempt (MESSAGE_ACK acking a MESSAGE_ACK)
  {
    const raw = connectRaw(); await raw.open();
    // Hand-crafted (makeEnvelope would reject an ack-loop client-side).
    raw.send({ protocolVersion: 1, messageId: generateId("msg"), type: "MESSAGE_ACK", workspaceId: id.workspaceId, workerId: id.workerId, sentAt: new Date().toISOString(), payload: { ackedMessageId: generateId("msg"), ackedType: "MESSAGE_ACK", status: "ACCEPTED", serverRevision: null, errorCode: null } });
    await waitFor(() => errorsOf(raw).length > 0);
    check("13 ACK loop rejected", errorsOf(raw)[0]?.payload.code, "E_INVALID_ENVELOPE");
  }
  // 14. prototype-pollution key in payload
  {
    const raw = connectRaw(); await raw.open();
    raw.send({ protocolVersion: 1, messageId: generateId("msg"), type: "WORKER_HEARTBEAT", workspaceId: id.workspaceId, workerId: id.workerId, sentAt: new Date().toISOString(), payload: { activeJobs: [], __proto__: { polluted: true } } });
    await tick(30);
    // __proto__ in a JSON literal is an own key; validateEnvelope rejects it OR it is
    // harmlessly ignored — either way NO pollution and NO crash.
    check("14 pollution key handled without crash", raw.ws.readyState === 1 || raw.ws.readyState === 3, true);
    check("14 Object prototype not polluted", ({}).polluted === undefined, true);
  }
  // no stack traces ever sent
  {
    const anyStack = raws.some((r) => r.messages.some((m) => JSON.stringify(m).includes("    at ") || /\.mjs:\d+/.test(JSON.stringify(m))));
    check("no stack trace sent over the wire", anyStack, false);
  }

  check("no unhandled rejection across suite", unhandled, false);
} finally {
  for (const r of raws) r.close();
  await tick(20);
  await plane.stop();
}

await tick(30);
if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
