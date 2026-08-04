// AVC Studio P0 Step 2 — JobRegistry (action → handler).
//
// PURE / in-memory. No provider-specific imports. Maps an allowlisted job
// action to a handler object. In Step 2, handlers are fakes supplied by tests
// or (later) thin wrappers over existing automation — the registry itself never
// imports Grok/ChatGPT/Python/fs.
//
// Handler contract:
//   { validate(input, context), execute(input, context), cancel?(context), recover?(context) }

import { PROTOCOL_ERRORS, protocolError } from "../protocol/errors.mjs";
import { JOB_ACTIONS } from "../protocol/job-contracts.mjs";

const ACTION_SET = new Set(JOB_ACTIONS);

function isValidHandler(handler) {
  return handler && typeof handler === "object"
    && typeof handler.validate === "function"
    && typeof handler.execute === "function";
}

export class JobRegistry {
  constructor() {
    this._handlers = new Map(); // action -> materialized handler
    this._lazy = new Map();     // action -> () => handler (materialized on first use)
  }

  // register(action, handler, options?) — options.replace allows overwrite.
  register(action, handler, options = {}) {
    if (!ACTION_SET.has(action)) {
      throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_ACTION, "Cannot register unknown action", { field: "action" });
    }
    if (!isValidHandler(handler)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Handler must expose validate() and execute()", { action });
    }
    if ((this._handlers.has(action) || this._lazy.has(action)) && !options.replace) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, `Handler already registered for ${action}`, { action });
    }
    this._lazy.delete(action);
    this._handlers.set(action, handler);
    return this;
  }

  // registerLazy(action, factory, options?) — defer handler construction until
  // first use (future providers may be expensive to build). The factory runs at
  // most once; its result is validated then cached like an eager registration.
  registerLazy(action, factory, options = {}) {
    if (!ACTION_SET.has(action)) {
      throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_ACTION, "Cannot register unknown action", { field: "action" });
    }
    if (typeof factory !== "function") {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Lazy handler factory must be a function", { action });
    }
    if ((this._handlers.has(action) || this._lazy.has(action)) && !options.replace) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, `Handler already registered for ${action}`, { action });
    }
    this._handlers.delete(action);
    this._lazy.set(action, factory);
    return this;
  }

  unregister(action) {
    const had = this._handlers.delete(action);
    return this._lazy.delete(action) || had;
  }

  _materialize(action) {
    if (this._handlers.has(action)) return this._handlers.get(action);
    const factory = this._lazy.get(action);
    if (!factory) return null;
    const handler = factory();
    if (!isValidHandler(handler)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Lazy factory produced an invalid handler", { action });
    }
    this._lazy.delete(action);
    this._handlers.set(action, handler);
    return handler;
  }

  // resolve(action) — throwing lookup used by the runtime.
  resolve(action) {
    const handler = this._materialize(action);
    if (!handler) {
      throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_ACTION, "No handler for action", { field: "action" });
    }
    return handler;
  }

  // get(action) — non-throwing lookup (materializes lazy). Returns null if absent.
  get(action) { return this._materialize(action); }

  has(action) { return this._handlers.has(action) || this._lazy.has(action); }
  list() { return [...new Set([...this._handlers.keys(), ...this._lazy.keys()])]; }
  listActions() { return this.list(); } // back-compat alias
}
