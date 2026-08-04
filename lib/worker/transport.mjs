// AVC Studio P0 Step 2 — JobTransport contract.
//
// PURE / in-memory abstraction. No network, no fs, no timers. Defines the
// message-channel contract between the control side (JobDispatcher) and the
// worker side (WorkerRuntime). MockTransport (mock-transport.mjs) is the only
// P0 Step 2 implementation. A future WSS transport will implement the same
// contract without changing dispatcher/runtime.
//
// Direction model (protocol §5):
//   control → worker :  offerJob(envelope), requestCancel(envelope)   [cloud→worker types]
//   worker  → control:  publishWorkerEvent(envelope)                  [worker→cloud types]
//   subscribeWorker(handler)  : worker side receives cloud→worker messages
//   subscribeControl(handler) : control side receives worker→cloud events

export const TRANSPORT_STATES = Object.freeze(["DISCONNECTED", "CONNECTED"]);

// Abstract base — documents the contract; every method throws until overridden.
export class JobTransport {
  connect() { notImplemented("connect"); }
  disconnect() { notImplemented("disconnect"); }
  isConnected() { notImplemented("isConnected"); }
  offerJob(_envelope) { notImplemented("offerJob"); }
  requestCancel(_envelope) { notImplemented("requestCancel"); }
  publishWorkerEvent(_envelope) { notImplemented("publishWorkerEvent"); }
  subscribeControl(_handler) { notImplemented("subscribeControl"); }
  subscribeWorker(_handler) { notImplemented("subscribeWorker"); }
  reconcile() { notImplemented("reconcile"); }
}

function notImplemented(name) {
  throw new Error(`JobTransport.${name} not implemented (use MockTransport or a concrete transport)`);
}
