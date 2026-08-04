// P0 Step 5C.3 — deterministic FAKE delivery adapter (TESTS ONLY).
//
// Never used in production code (the default production adapter is `unavailable`). Records every
// send (messageId, type, sentAt) so tests can assert messageId preservation + sentAt re-stamping,
// and lets a test program the transport result per messageId / per type / as a scripted sequence
// / via a callback. `available: true` so the outbox processor treats it as a usable transport.

export function createFakeDeliveryAdapter({ defaultResult = "WRITTEN", script = null, onSend = null } = {}) {
  const sent = [];                 // [{ workerId, messageId, type, sentAt, connectionSessionId }]
  const byMessageId = new Map();   // messageId → result
  const byType = new Map();        // type → result
  let scriptIdx = 0;

  return {
    available: true,
    kind: "fake",
    sent,
    // Program a result. key beginning with "msg_" → per messageId; otherwise → per type.
    setResult(key, result) { (String(key).startsWith("msg_") ? byMessageId : byType).set(key, result); },
    setMessageResult(messageId, result) { byMessageId.set(messageId, result); },
    setTypeResult(type, result) { byType.set(type, result); },
    clear() { sent.length = 0; byMessageId.clear(); byType.clear(); scriptIdx = 0; },
    countFor(messageId) { return sent.filter((s) => s.messageId === messageId).length; },

    async sendToWorker({ workerId, connectionSessionId, gatewayInstance, envelope, signal }) {
      sent.push({ workerId, messageId: envelope.messageId, type: envelope.type, sentAt: envelope.sentAt, connectionSessionId, gatewayInstance, envelope });
      if (typeof onSend === "function") {
        const r = onSend({ workerId, connectionSessionId, envelope, count: sent.length });
        if (r) return { result: r };
      }
      if (byMessageId.has(envelope.messageId)) return { result: byMessageId.get(envelope.messageId) };
      if (byType.has(envelope.type)) return { result: byType.get(envelope.type) };
      if (Array.isArray(script) && scriptIdx < script.length) return { result: script[scriptIdx++] };
      return { result: defaultResult };
    }
  };
}
