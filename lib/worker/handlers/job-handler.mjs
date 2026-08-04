// AVC Studio P0 Step 4A — JobHandler interface (PURE).
//
// PURE MODULE. Imports only the protocol contract layer. A JobHandler is the ONLY
// place provider-specific logic may live in later steps. It must know NOTHING about
// the dispatcher, transport, WebSocket, cloud, browser, or filesystem — it receives
// everything it needs through the execution `context` supplied by the runtime.
//
// Interface (all methods optional except execute; defaults are filled by defineHandler):
//
//   capabilities()            → string[]   capability tags this handler needs
//                                          (must match actionRequiredCapability).
//   validate(input, ctx)      → void       throw a ProtocolError to REJECT before
//                                          execution (JOB_REJECTED). No-op default.
//   execute(input, ctx)       → result     do the work. ctx = {
//                                            jobId, workerId, workspaceId, input,
//                                            signal (AbortSignal),
//                                            durationContext, onProgress(evt),
//                                            markSubmitting(evidence?),
//                                            markSubmittedToProvider(subId?),
//                                            markResultAvailable(evt?),
//                                            markDownloading(),
//                                            markLocalResult(ref, assetId?, meta?)
//                                          }. Return { result } or a plain result;
//                                          return { needsManualAction, reason, message }
//                                          to park; throw → JOB_FAILED (sanitized).
//   cancel(ctx)               → void       cooperative-cancel hook (the runtime also
//                                          aborts ctx.signal). No-op default.
//   recover(record)           → any|null   inspect a journal record and describe safe
//                                          recovery; null → defer to journal classifier.

import { JOB_ACTIONS, actionRequiredCapability } from "../../protocol/job-contracts.mjs";
import { PROTOCOL_ERRORS, protocolError } from "../../protocol/errors.mjs";

const ACTION_SET = new Set(JOB_ACTIONS);

// assertHandlerShape(handler): throws if the handler cannot be registered/run.
export function assertHandlerShape(handler, action = undefined) {
  if (!handler || typeof handler !== "object") {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Handler must be an object", { action });
  }
  if (typeof handler.execute !== "function") {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Handler must expose execute()", { action });
  }
  if (typeof handler.validate !== "function") {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Handler must expose validate()", { action });
  }
  return handler;
}

// defineHandler(spec): normalize a handler spec into a full JobHandler with every
// interface method present (defaults for the optional ones). PURE — returns a plain
// object; no side effects.
//   spec = { action, capability?|capabilities?, validate?, execute, cancel?, recover? }
export function defineHandler(spec = {}) {
  const { action } = spec;
  if (!ACTION_SET.has(action)) {
    throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_ACTION, "defineHandler requires a known action", { field: "action" });
  }
  if (typeof spec.execute !== "function") {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "defineHandler requires execute()", { action });
  }

  // Resolve declared capabilities; default to the action's required capability.
  let capabilities;
  if (Array.isArray(spec.capabilities)) capabilities = [...spec.capabilities];
  else if (typeof spec.capability === "string") capabilities = [spec.capability];
  else {
    const req = actionRequiredCapability(action);
    capabilities = req ? [req] : [];
  }

  const handler = {
    action,
    capabilities: () => [...capabilities],
    validate: typeof spec.validate === "function" ? spec.validate : () => {},
    execute: spec.execute,
    cancel: typeof spec.cancel === "function" ? spec.cancel : () => {},
    recover: typeof spec.recover === "function" ? spec.recover : () => null
  };
  return assertHandlerShape(handler, action);
}
