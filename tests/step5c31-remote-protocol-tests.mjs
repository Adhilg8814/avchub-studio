// P0 Step 5C.31 — remote delivery PROTOCOL contract (provider-free, no PostgreSQL).
//
// The wire format is the boundary between a machine we control and a machine we merely trust to have
// been paired. These tests pin the properties that make that boundary safe: a frame can never smuggle
// a credential, an unsupported protocol version is refused rather than half-accepted, malformed ids
// are rejected before any handler sees them, and self-reported capabilities are sanitised to a fixed
// shape so a remote machine cannot inject arbitrary content into durable state.

import assert from "node:assert/strict";
import {
  DELIVERY_PROTOCOL_VERSION, SUPPORTED_DELIVERY_PROTOCOL_VERSIONS, REMOTE_WORKER_WS_PATH,
  MAX_FRAME_BYTES, S2W, W2S, DURABLE_COMMANDS, CLOSE_REASON, REMOTE_ERRORS,
  parseFrame, makeFrame, frameCarriesSecret, sanitizeCapabilities, buildOfferPayload,
  isJobId, isAttemptId, isWorkerId, isCommandId
} from "../lib/worker/remote/remote-protocol.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const enc = (o) => Buffer.from(JSON.stringify(o), "utf8");

const JOB = "job_01KY2ADR79GP5SCR41MEKG790Z";
const ATT = "attempt_01KY2ADR79GP5SCR41MEKG790Z";
const WRK = "wrk_01KY2ADR79GP5SCR41MEKG790Z";

// ---------------------------------------------------------------- 1. identifiers
check("P1 job id shape accepted", isJobId(JOB));
check("P2 job id with wrong prefix refused", !isJobId("mov_01KY2ADR79GP5SCR41MEKG790Z"));
check("P3 attempt id shape accepted", isAttemptId(ATT));
check("P4 worker id shape accepted", isWorkerId(WRK));
check("P5 command id shape accepted", isCommandId("cmd_0123456789abcdef"));
check("P6 command id with spaces refused", !isCommandId("cmd with space"));
check("P7 short command id refused", !isCommandId("cmd"));

// ---------------------------------------------------------------- 2. version negotiation
check("P8 server advertises v1", DELIVERY_PROTOCOL_VERSION === 1 && SUPPORTED_DELIVERY_PROTOCOL_VERSIONS.includes(1));
const wrongVersion = parseFrame(enc({ p: 99, t: W2S.HELLO }), false);
check("P9 unsupported protocol version refused with a distinct code",
  !wrongVersion.ok && wrongVersion.code === REMOTE_ERRORS.E_REMOTE_PROTOCOL_VERSION);
const noVersion = parseFrame(enc({ t: W2S.HELLO }), false);
check("P10 missing protocol version refused (never assumed)", !noVersion.ok);

// ---------------------------------------------------------------- 3. frame safety
check("P11 binary frame refused", !parseFrame(Buffer.from([1, 2, 3]), true).ok);
check("P12 empty frame refused", !parseFrame(Buffer.alloc(0), false).ok);
check("P13 non-JSON frame refused", !parseFrame(Buffer.from("not json", "utf8"), false).ok);
check("P14 array payload refused (must be an object)", !parseFrame(enc([1, 2, 3]), false).ok);
const huge = { p: 1, t: W2S.PROGRESS, d: { pad: "x".repeat(MAX_FRAME_BYTES + 10) } };
check("P15 oversized frame refused before parsing effects", !parseFrame(enc(huge), false).ok);
check("P16 malformed job id refused", !parseFrame(enc({ p: 1, t: W2S.ACCEPT, j: "job_bad" }), false).ok);
check("P17 malformed attempt id refused", !parseFrame(enc({ p: 1, t: W2S.ACCEPT, a: "attempt_x" }), false).ok);
check("P18 negative sequence refused", !parseFrame(enc({ p: 1, t: W2S.PROGRESS, seq: -1 }), false).ok);
check("P19 non-integer sequence refused", !parseFrame(enc({ p: 1, t: W2S.PROGRESS, seq: 1.5 }), false).ok);
check("P20 non-object payload refused", !parseFrame(enc({ p: 1, t: W2S.PROGRESS, d: "string" }), false).ok);
const good = parseFrame(enc({ p: 1, t: W2S.ACCEPT, j: JOB, a: ATT, cid: "cmd_0123456789abcdef", seq: 3, d: { stage: "GATE_PASSED" } }), false);
check("P21 well-formed frame accepted with all fields", good.ok && good.frame.j === JOB && good.frame.seq === 3);

// ---------------------------------------------------------------- 4. no secret may ever cross the wire
check("P22 payload with a `credential` key refused",
  !parseFrame(enc({ p: 1, t: W2S.HELLO, d: { credential: "wcred_abc" } }), false).ok);
check("P23 payload with an `authorization` key refused",
  !parseFrame(enc({ p: 1, t: W2S.HELLO, d: { authorization: "Bearer x" } }), false).ok);
check("P24 nested secret key refused",
  !parseFrame(enc({ p: 1, t: W2S.HELLO, d: { config: { password: "x" } } }), false).ok);
check("P25 a wcred_-shaped VALUE anywhere is refused even under a harmless key",
  !parseFrame(enc({ p: 1, t: W2S.HELLO, d: { note: "wcred_0123456789" } }), false).ok);
check("P26 frameCarriesSecret is case-insensitive", frameCarriesSecret({ d: { ToKeN: "x" } }));
check("P27 an ordinary payload carries no secret", !frameCarriesSecret({ d: { stage: "GATE_PASSED", sizeBytes: 10 } }));

// ---------------------------------------------------------------- 5. capabilities sanitisation
const caps = sanitizeCapabilities({
  cloakReady: true, ffmpegReady: false, interactiveSession: true,
  cloakVersion: "1.2.3", actions: ["GENERATE_IMAGINE_VIDEO", "not-an-action", "X"],
  maxConcurrentGenerations: 1,
  evil: "<script>", nested: { drop: true }, hugeString: "y".repeat(500)
});
check("P28 unknown capability keys are dropped", caps.evil === undefined && caps.nested === undefined);
check("P29 known booleans preserved", caps.cloakReady === true && caps.ffmpegReady === false);
check("P30 action list filtered to the strict shape", Array.isArray(caps.actions) && caps.actions.length === 1 && caps.actions[0] === "GENERATE_IMAGINE_VIDEO");
check("P31 oversized string values dropped", caps.hugeString === undefined);
check("P32 concurrency clamped to a sane range", caps.maxConcurrentGenerations === 1);
check("P33 non-object capabilities -> null", sanitizeCapabilities("nope") === null && sanitizeCapabilities(null) === null);
check("P34 out-of-range concurrency dropped", sanitizeCapabilities({ maxConcurrentGenerations: 99 })?.maxConcurrentGenerations === undefined);

// ---------------------------------------------------------------- 6. frame construction
const f = makeFrame({ type: S2W.OFFER, messageId: "msg_1", jobId: JOB, attemptId: ATT, payload: { a: 1 }, now: () => "2026-07-25T00:00:00.000Z" });
check("P35 built frame carries the negotiated version", f.p === DELIVERY_PROTOCOL_VERSION);
check("P36 built frame is round-trippable", parseFrame(enc(f), false).ok);
check("P37 makeFrame refuses a typeless frame", (() => { try { makeFrame({ messageId: "m" }); return false; } catch { return true; } })());

const offer = buildOfferPayload({ prompt: "a boat", durationSeconds: 6, aspectRatio: "9:16", leaseExpiresAt: "2026-07-25T00:05:00.000Z" });
check("P38 offer payload carries only execution inputs (no ids, no tenant, no secret)",
  Object.keys(offer).sort().join(",") === "action,aspectRatio,cooldownMs,durationSeconds,leaseExpiresAt,offerExpiresAt,prompt,provider,providerAccountHint");
check("P39 offer payload defaults are sane", offer.provider === "GROK" && offer.action === "GENERATE_IMAGINE_VIDEO" && offer.aspectRatio === "9:16");

// ---------------------------------------------------------------- 7. message-type inventory
const required = ["OFFER", "LEASE_GRANTED", "LEASE_RENEWED", "DRAIN", "CANCEL", "UPLOAD_GRANT", "ACK", "NACK", "HELLO_ACK", "PING", "UPDATE_AVAILABLE"];
check("P40 every required hub->worker type exists", required.every((t) => S2W[t] === t));
const requiredW = ["HELLO", "READY", "ACCEPT", "REJECT", "PROGRESS", "SUBMIT_ATTEMPTED", "SUBMITTED", "RESULT_READY", "ARTIFACT_UPLOADED", "COMPLETE", "FAIL", "RELEASE", "DRAIN_ACK", "LEASE_RENEW", "HEARTBEAT", "PONG"];
check("P41 every required worker->hub type exists", requiredW.every((t) => W2S[t] === t));
check("P42 all durable commands are worker->hub types", [...DURABLE_COMMANDS].every((k) => Object.values(W2S).includes(k)));
check("P43 HELLO and READY are NOT durable commands (they mutate no job state)",
  !DURABLE_COMMANDS.has(W2S.HELLO) && !DURABLE_COMMANDS.has(W2S.READY));
check("P44 close reasons are distinct application codes in the 4000 range",
  new Set(Object.values(CLOSE_REASON).map((c) => c.code)).size === Object.values(CLOSE_REASON).length
  && Object.values(CLOSE_REASON).filter((c) => c.code !== 1000).every((c) => c.code >= 4000 && c.code < 5000));
check("P45 the worker WS path lives under the WORKER route policy prefix", REMOTE_WORKER_WS_PATH.startsWith("/api/worker/"));

console.log(`Step 5C.31 remote protocol: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
assert.equal(failed, 0);
