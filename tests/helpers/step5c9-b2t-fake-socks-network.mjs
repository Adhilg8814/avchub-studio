// P0 Step 5C.9B2T - provider-free browser-like SOCKS5 fan-out fixtures.
//
// Every listener binds numeric loopback. Requested synthetic hostnames are
// resolved only through an explicit in-memory routing table owned by the fake
// SOCKS server; no DNS lookup or non-loopback connection is possible.

import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";

import {
  FAKE_TLS_PROXY_CA,
  FAKE_TLS_PROXY_PFX,
  FAKE_TLS_PROXY_PFX_PASSPHRASE
} from "./step5c9-b1c-fake-proxy-network.mjs";

export { FAKE_TLS_PROXY_CA };

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true, backlog: 511 }, () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    });
  });
}

async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => {
    if (!server.listening) return resolve();
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    server.close(finish);
    server.closeAllConnections?.();
    timer = setTimeout(finish, 2_000);
  });
}

function trackSocket(socket, sockets) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

export async function createB2tTlsHttpDestination({ slowDelayMs = 35 } = {}) {
  const sockets = new Set();
  let acceptedConnectionCount = 0;
  let activeConnectionCount = 0;
  let activeConnectionHighWaterMark = 0;
  let requestCount = 0;
  const receivedIds = new Set();
  const server = tls.createServer({
    allowHalfOpen: true,
    pfx: FAKE_TLS_PROXY_PFX,
    passphrase: FAKE_TLS_PROXY_PFX_PASSPHRASE
  }, (socket) => {
    trackSocket(socket, sockets);
    acceptedConnectionCount += 1;
    activeConnectionCount += 1;
    activeConnectionHighWaterMark = Math.max(activeConnectionHighWaterMark, activeConnectionCount);
    socket.once("close", () => { activeConnectionCount -= 1; });
    let request = Buffer.alloc(0);
    socket.on("data", async (chunk) => {
      request = Buffer.concat([request, chunk], request.length + chunk.length);
      const boundary = request.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      socket.removeAllListeners("data");
      const header = request.subarray(0, boundary + 4).toString("latin1");
      const match = /^GET \/(?:fast|slow)\/([A-Za-z0-9_-]{1,64}) HTTP\/1\.1\r$/mu.exec(header);
      if (!match) {
        socket.end("HTTP/1.1 400 Synthetic\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      requestCount += 1;
      receivedIds.add(match[1]);
      if (header.startsWith("GET /slow/")) await delay(slowDelayMs);
      const body = `intact:${match[1]}`;
      socket.end(
        `HTTP/1.1 200 Synthetic\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        "latin1"
      );
    });
  });
  server.on("tlsClientError", () => {});
  const port = await listen(server);
  return Object.freeze({
    port,
    get acceptedConnectionCount() { return acceptedConnectionCount; },
    get activeConnectionCount() { return activeConnectionCount; },
    get activeConnectionHighWaterMark() { return activeConnectionHighWaterMark; },
    get requestCount() { return requestCount; },
    hasReceived(id) { return receivedIds.has(id); },
    resourceProbe() {
      return Object.freeze({ listening: server.listening, ownedSocketCount: sockets.size });
    },
    close: () => closeServer(server, sockets)
  });
}

export async function createB2tTlsEchoDestination() {
  const sockets = new Set();
  let acceptedConnectionCount = 0;
  const server = tls.createServer({
    allowHalfOpen: true,
    pfx: FAKE_TLS_PROXY_PFX,
    passphrase: FAKE_TLS_PROXY_PFX_PASSPHRASE
  }, (socket) => {
    trackSocket(socket, sockets);
    acceptedConnectionCount += 1;
    socket.on("data", (chunk) => socket.write(chunk));
    socket.once("end", () => socket.end());
  });
  server.on("tlsClientError", () => {});
  const port = await listen(server);
  return Object.freeze({
    port,
    get acceptedConnectionCount() { return acceptedConnectionCount; },
    resourceProbe() {
      return Object.freeze({ listening: server.listening, ownedSocketCount: sockets.size });
    },
    close: () => closeServer(server, sockets)
  });
}

/**
 * A TLS echo destination that deliberately stops reading the request long
 * enough to fill the forwarding path, then writes the complete multi-megabyte
 * response while the test client is also paused. The payload is synthetic and
 * is retained only until that one round trip finishes.
 */
export async function createB2tTlsBackpressureDestination({
  expectedRequestBytes,
  readPauseMs = 75
} = {}) {
  if (!Number.isSafeInteger(expectedRequestBytes) || expectedRequestBytes < 64 * 1024 ||
      expectedRequestBytes > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(readPauseMs) || readPauseMs < 1 || readPauseMs > 2_000) {
    throw new Error("invalid synthetic backpressure destination");
  }
  const sockets = new Set();
  let acceptedConnectionCount = 0;
  let activeConnectionCount = 0;
  let completedRoundTripCount = 0;
  let receivedByteCount = 0;
  let responseBackpressureObserved = false;
  const server = tls.createServer({
    allowHalfOpen: true,
    pfx: FAKE_TLS_PROXY_PFX,
    passphrase: FAKE_TLS_PROXY_PFX_PASSPHRASE
  }, (socket) => {
    trackSocket(socket, sockets);
    acceptedConnectionCount += 1;
    activeConnectionCount += 1;
    const chunks = [];
    let size = 0;
    let completed = false;
    socket.pause();
    const resumeTimer = setTimeout(() => socket.resume(), readPauseMs);
    resumeTimer.unref?.();
    socket.once("close", () => {
      clearTimeout(resumeTimer);
      activeConnectionCount -= 1;
    });
    socket.on("data", (chunk) => {
      if (completed) return;
      size += chunk.length;
      if (size > expectedRequestBytes) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (size !== expectedRequestBytes) return;
      completed = true;
      socket.removeAllListeners("data");
      const payload = Buffer.concat(chunks, size);
      receivedByteCount += size;
      completedRoundTripCount += 1;
      // A multi-megabyte write while the peer is paused must cross the
      // writable high-water mark. Calling end afterwards preserves normal
      // stream ordering while Node drains the buffered response.
      responseBackpressureObserved ||= !socket.write(payload);
      socket.end();
    });
  });
  server.on("tlsClientError", () => {});
  const port = await listen(server);
  return Object.freeze({
    port,
    get acceptedConnectionCount() { return acceptedConnectionCount; },
    get activeConnectionCount() { return activeConnectionCount; },
    get completedRoundTripCount() { return completedRoundTripCount; },
    get receivedByteCount() { return receivedByteCount; },
    get responseBackpressureObserved() { return responseBackpressureObserved; },
    resourceProbe() {
      return Object.freeze({ listening: server.listening, ownedSocketCount: sockets.size });
    },
    close: () => closeServer(server, sockets)
  });
}

export async function createB2tHalfCloseDestination() {
  const sockets = new Set();
  let acceptedConnectionCount = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    trackSocket(socket, sockets);
    acceptedConnectionCount += 1;
    let received = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => { received += chunk; });
    socket.once("end", () => socket.end(`ack:${received}`, "latin1"));
  });
  const port = await listen(server);
  return Object.freeze({
    port,
    get acceptedConnectionCount() { return acceptedConnectionCount; },
    resourceProbe() {
      return Object.freeze({ listening: server.listening, ownedSocketCount: sockets.size });
    },
    close: () => closeServer(server, sockets)
  });
}

export async function createB2tUpstreamHalfCloseDestination() {
  const sockets = new Set();
  let acceptedConnectionCount = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    trackSocket(socket, sockets);
    acceptedConnectionCount += 1;
    socket.once("data", (chunk) => socket.end(Buffer.concat([
      Buffer.from("upstream-ack:"),
      chunk
    ])));
  });
  const port = await listen(server);
  return Object.freeze({
    port,
    get acceptedConnectionCount() { return acceptedConnectionCount; },
    resourceProbe() {
      return Object.freeze({ listening: server.listening, ownedSocketCount: sockets.size });
    },
    close: () => closeServer(server, sockets)
  });
}

function parseSocksTarget(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0x05 || buffer[1] !== 0x01 || buffer[2] !== 0x00) {
    return { invalid: true };
  }
  const type = buffer[3];
  if (type === 0x01) {
    if (buffer.length < 10) return null;
    return {
      host: [...buffer.subarray(4, 8)].join("."),
      port: buffer.readUInt16BE(8),
      consumed: 10
    };
  }
  if (type === 0x03) {
    if (buffer.length < 5) return null;
    const length = buffer[4];
    if (buffer.length < 7 + length) return null;
    return {
      host: buffer.subarray(5, 5 + length).toString("utf8"),
      port: buffer.readUInt16BE(5 + length),
      consumed: 7 + length
    };
  }
  return { invalid: true };
}

async function writeFragmented(socket, value, { fragmentSize, fragmentDelayMs }) {
  for (let offset = 0; offset < value.length; offset += fragmentSize) {
    if (socket.destroyed) return false;
    const chunk = value.subarray(offset, Math.min(value.length, offset + fragmentSize));
    if (!socket.write(chunk)) {
      await new Promise((resolve) => socket.once("drain", resolve));
    }
    if (fragmentDelayMs) await delay(fragmentDelayMs);
  }
  return !socket.destroyed;
}

/**
 * A strict loopback-only authenticated SOCKS5 upstream. Routes map synthetic
 * hostnames to loopback destination ports. Requested hostnames are never
 * resolved through the operating system.
 */
export async function createB2tAuthenticatedSocks5Upstream({
  username = "fixture-user",
  password = "fixture-pass",
  routes,
  fragmentSize = 1,
  fragmentDelayMs = 0,
  stallGreeting = false
} = {}) {
  if (!(routes instanceof Map) || routes.size < 1) throw new Error("invalid synthetic routes");
  const downstreamSockets = new Set();
  const destinationSockets = new Set();
  const requestedHosts = [];
  const connectionIds = new Set();
  let nextConnectionId = 0;
  let acceptedConnectionCount = 0;
  let activeConnectionCount = 0;
  let activeConnectionHighWaterMark = 0;
  let socksHandshakeSuccessCount = 0;
  let socksHandshakeFailureCount = 0;
  const failureStages = [];

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    trackSocket(socket, downstreamSockets);
    const connectionId = ++nextConnectionId;
    connectionIds.add(connectionId);
    acceptedConnectionCount += 1;
    activeConnectionCount += 1;
    activeConnectionHighWaterMark = Math.max(activeConnectionHighWaterMark, activeConnectionCount);
    socket.once("close", () => { activeConnectionCount -= 1; });
    let stage = "GREETING";
    let buffer = Buffer.alloc(0);
    let destination = null;
    let processing = false;
    socket.once("end", () => {
      if (stage !== "STREAM") socket.destroy();
    });

    const reject = async (reply, stageName) => {
      socksHandshakeFailureCount += 1;
      failureStages.push(stageName);
      await writeFragmented(socket, reply, { fragmentSize, fragmentDelayMs });
      socket.end();
    };

    const process = async () => {
      if (processing) return;
      processing = true;
      try {
        while (!socket.destroyed) {
          if (stage === "GREETING") {
            if (buffer.length < 2) return;
            const count = buffer[1];
            if (buffer.length < 2 + count) return;
            const methods = buffer.subarray(2, 2 + count);
            buffer = buffer.subarray(2 + count);
            if (stallGreeting) return;
            if (!methods.includes(0x02)) {
              await reject(Buffer.from([0x05, 0xff]), "GREETING");
              return;
            }
            stage = "AUTH";
            await writeFragmented(socket, Buffer.from([0x05, 0x02]), { fragmentSize, fragmentDelayMs });
          } else if (stage === "AUTH") {
            if (buffer.length < 2) return;
            const userLength = buffer[1];
            if (buffer.length < 3 + userLength) return;
            const passwordLength = buffer[2 + userLength];
            const total = 3 + userLength + passwordLength;
            if (buffer.length < total) return;
            const actualUser = buffer.subarray(2, 2 + userLength).toString("utf8");
            const actualPassword = buffer.subarray(3 + userLength, total).toString("utf8");
            buffer = buffer.subarray(total);
            if (actualUser !== username || actualPassword !== password) {
              await reject(Buffer.from([0x01, 0x01]), "AUTH");
              return;
            }
            stage = "CONNECT";
            await writeFragmented(socket, Buffer.from([0x01, 0x00]), { fragmentSize, fragmentDelayMs });
          } else if (stage === "CONNECT") {
            const target = parseSocksTarget(buffer);
            if (!target) return;
            if (target.invalid) {
              await reject(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]), "PROTOCOL");
              return;
            }
            const remainder = buffer.subarray(target.consumed);
            buffer = Buffer.alloc(0);
            requestedHosts.push(target.host);
            const route = routes.get(target.host);
            if (!route || route.targetPort !== target.port || route.reject === true) {
              await reject(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]), "TARGET");
              return;
            }
            if (route.connectDelayMs) await delay(route.connectDelayMs);
            destination = trackSocket(net.connect({
              host: "127.0.0.1",
              port: route.destinationPort,
              allowHalfOpen: true
            }), destinationSockets);
            destination.once("error", () => socket.destroy());
            socket.once("error", () => destination?.destroy());
            socket.once("close", () => destination?.destroy());
            await new Promise((resolve, rejectConnect) => {
              destination.once("connect", resolve);
              destination.once("error", rejectConnect);
            }).catch(async () => {
              await reject(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]), "DESTINATION");
            });
            if (socket.destroyed || !destination || destination.destroyed) return;
            stage = "STREAM";
            socksHandshakeSuccessCount += 1;
            // Freeze downstream reads while handing parser ownership to the
            // duplex pipes. A client may send its first TLS/application bytes
            // as soon as the last success-reply fragment is visible; without
            // this pause those bytes can land in the parser buffer between the
            // awaited write and listener removal.
            socket.pause();
            const delivered = await writeFragmented(
              socket,
              Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]),
              { fragmentSize, fragmentDelayMs }
            );
            if (!delivered) return;
            socket.removeListener("data", onData);
            const queued = buffer.length
              ? Buffer.concat([remainder, buffer], remainder.length + buffer.length)
              : remainder;
            buffer = Buffer.alloc(0);
            if (queued.length) destination.write(queued);
            socket.pipe(destination);
            destination.pipe(socket);
            if (Number.isInteger(route.upstreamResetAfterMs) &&
                route.upstreamResetAfterMs >= 1 && route.upstreamResetAfterMs <= 5_000) {
              const resetTimer = setTimeout(() => {
                if (socket.destroyed) return;
                if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
                else socket.destroy(new Error("synthetic upstream reset"));
              }, route.upstreamResetAfterMs);
              resetTimer.unref?.();
              socket.once("close", () => clearTimeout(resetTimer));
            }
            socket.resume();
            return;
          } else return;
        }
      } finally {
        processing = false;
      }
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk], buffer.length + chunk.length);
      void process();
    };
    socket.on("data", onData);
  });
  const port = await listen(server);
  return Object.freeze({
    host: "127.0.0.1",
    port,
    get acceptedConnectionCount() { return acceptedConnectionCount; },
    get activeConnectionCount() { return activeConnectionCount; },
    get activeConnectionHighWaterMark() { return activeConnectionHighWaterMark; },
    get socksHandshakeSuccessCount() { return socksHandshakeSuccessCount; },
    get socksHandshakeFailureCount() { return socksHandshakeFailureCount; },
    get failureStages() { return Object.freeze([...failureStages]); },
    get uniqueConnectionCount() { return connectionIds.size; },
    get requestedHosts() { return Object.freeze([...requestedHosts]); },
    resourceProbe() {
      return Object.freeze({
        listening: server.listening,
        downstreamSocketCount: downstreamSockets.size,
        destinationSocketCount: destinationSockets.size
      });
    },
    close: () => closeServer(server, new Set([...downstreamSockets, ...destinationSockets]))
  });
}

function loopbackEndpoint(descriptor) {
  const parsed = new URL(descriptor.server);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
      parsed.username || parsed.password || parsed.pathname !== "/") {
    throw new Error("unsafe synthetic loopback descriptor");
  }
  return { host: parsed.hostname, port: Number(parsed.port) };
}

export function openB2tConnectTunnel(descriptor, targetHost, targetPort, { timeoutMs = 5_000 } = {}) {
  const endpoint = loopbackEndpoint(descriptor);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ ...endpoint, allowHalfOpen: true });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(socket);
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("CONNECT_CLOSED"));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk], buffer.length + chunk.length);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const status = /^HTTP\/1\.1 ([0-9]{3}) /u.exec(
        buffer.subarray(0, boundary + 4).toString("latin1")
      )?.[1];
      if (status !== "200") return finish(new Error(`CONNECT_${status ?? "INVALID"}`));
      const remainder = buffer.subarray(boundary + 4);
      socket.pause();
      if (remainder.length) socket.unshift(remainder);
      finish();
    };
    const timer = setTimeout(() => finish(new Error("CONNECT_TIMEOUT")), timeoutMs);
    timer.unref?.();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("connect", () => {
      const authority = `${targetHost}:${targetPort}`;
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`, "latin1");
    });
  });
}

export async function openB2tTlsTunnelPair(
  descriptor,
  targetHost,
  targetPort,
  { timeoutMs = 5_000 } = {}
) {
  const raw = await openB2tConnectTunnel(descriptor, targetHost, targetPort, { timeoutMs });
  const secure = await new Promise((resolve, reject) => {
    const socket = tls.connect({
      socket: raw,
      servername: "localhost",
      ca: FAKE_TLS_PROXY_CA,
      rejectUnauthorized: true,
      allowHalfOpen: true
    });
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("secureConnect", onReady);
      socket.removeListener("error", onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) { socket.destroy(); reject(error); } else resolve(socket);
    };
    const onReady = () => finish();
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(new Error("TLS_TIMEOUT")), timeoutMs);
    timer.unref?.();
    socket.once("secureConnect", onReady);
    socket.once("error", onError);
  });
  return Object.freeze({ raw, secure });
}

export async function openB2tTlsTunnel(descriptor, targetHost, targetPort, { timeoutMs = 5_000 } = {}) {
  return (await openB2tTlsTunnelPair(
    descriptor,
    targetHost,
    targetPort,
    { timeoutMs }
  )).secure;
}

export async function requestB2tTls({
  descriptor,
  targetHost,
  targetPort,
  requestId,
  slow = false,
  timeoutMs = 8_000
}) {
  let socket;
  try {
    socket = await openB2tTlsTunnel(descriptor, targetHost, targetPort, { timeoutMs });
    return await new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (ok, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(Object.freeze({ ok, reason }));
      };
      const timer = setTimeout(() => finish(false, "RESPONSE_TIMEOUT"), timeoutMs);
      timer.unref?.();
      socket.setEncoding("latin1");
      socket.on("data", (chunk) => { output += chunk; });
      socket.once("error", (error) => finish(false, error.code ?? "TLS_ERROR"));
      const finishFromOutput = () => finish(
        output.includes("HTTP/1.1 200 Synthetic") && output.endsWith(`intact:${requestId}`),
        output.includes("HTTP/1.1 200 Synthetic") ? "INTEGRITY" : "CLOSED"
      );
      socket.once("end", finishFromOutput);
      socket.once("close", finishFromOutput);
      socket.write(
        `GET /${slow ? "slow" : "fast"}/${requestId} HTTP/1.1\r\n` +
        "Host: synthetic.test\r\nConnection: close\r\n\r\n",
        "latin1"
      );
    });
  } catch (error) {
    socket?.destroy();
    return Object.freeze({ ok: false, reason: error?.code ?? error?.message ?? "FAILED" });
  }
}

export async function waitForB2t(predicate, { timeoutMs = 3_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return Boolean(predicate());
}
