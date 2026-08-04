// Loopback-only fake network for Step 5C.9B1C. No external endpoint is used.

import net from "node:net";
import tls from "node:tls";

// Synthetic, test-only localhost certificate material. The corresponding PFX
// is used only by the loopback TLS proxy below; production code receives only
// the exported certificate through an injected TLS trust seam.
export const FAKE_TLS_PROXY_CA = `-----BEGIN CERTIFICATE-----
MIIC5jCCAc6gAwIBAgIIFAeYvsEowq0wDQYJKoZIhvcNAQELBQAwFDESMBAGA1UE
AxMJbG9jYWxob3N0MB4XDTI2MDcxMzA1MTEyMFoXDTMxMDcxNDA1MTEyMFowFDES
MBAGA1UEAxMJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEAsTOamifOrtL6tN/FSq7a2MeuSWsqvgVtWDX2B9/Rvt8LYVHbGqfqZR3MliZq
lu+Hu0sZglFJPclPhr24KtkHZRr9jeO22B/wxE4SjU7OBH3yGA1X0lQNKI3ITnpI
+EJ0Wsvdo9N3oa13hVqni+kmAEKmdTg4I5S6gZIhEmm8qGuIcYKa0yVxzlfArRSc
0RGFEZFTX4CdO40wZPzrDMyiJroijE5LPyAVAg4nkCKh84uzgqmslLxkTrNis0aa
pmiTwAYJziQf1aa/S8oxnDbqt04wT5URf0T1dkDg4Nsz4dHHXwvAuVEveU/SPtlw
Da/RrCfk+v54YwFtL5YG9OiP5QIDAQABozwwOjAaBgNVHREEEzARgglsb2NhbGhv
c3SHBH8AAAEwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwDQYJKoZIhvcN
AQELBQADggEBADON3+aqVi/1e5kHajcEnntlIa0yCDG0Sxec2XoEthRCjEbu5utM
muIOawgyLy+U+rQq9HBTHN4WOAom11/xlkOt4PxEGvaeF1cWkV2wVhgGkFZtcA8T
8F2cdZ39EQzumoJ2QG7e6N9WhIjjuQRfTCez+jKWw9jeRMw7zlLs6z52QdVVoRoG
T/KbaWGFRwnNlrGdXwbPIUXkuPkoF1ZnCvgDUkhW08FswIphLkDBRN5vJj1Mf/2V
p1Ujue8Soub1T0Rh0ksu+ATqX4bYwebQdVxHnCuUGqz53IxqPwQ8can7JFSxq5//
mscgsRqfxrmAOZ63h4nd2Fy4nk7xcrvXR3w=
-----END CERTIFICATE-----`;

export const FAKE_TLS_PROXY_PFX = Buffer.from(
  "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",
  "base64"
);
export const FAKE_TLS_PROXY_PFX_PASSPHRASE = "fixture-pfx-pass";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function pipeDestination(client, destinationPort, onConnected) {
  const upstream = net.connect({ host: "127.0.0.1", port: destinationPort });
  upstream.once("connect", () => {
    onConnected(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.once("error", () => client.destroy());
  return upstream;
}

export async function createFakeHealthDestination() {
  const sockets = new Set();
  let requests = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.indexOf("\r\n\r\n") < 0) return;
      requests += 1;
      socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  });
  const port = await listen(server);
  return Object.freeze({
    host: "127.0.0.1",
    port,
    get requestCount() { return requests; },
    close: () => close(server, sockets)
  });
}

function headerReader(socket, callback) {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    socket.removeListener("data", onData);
    callback(buffer.subarray(0, boundary + 4).toString("latin1"), buffer.subarray(boundary + 4));
  };
  socket.on("data", onData);
}

export async function createFakeAuthenticatedHttpProxy({
  username = "fixture-user",
  password = "fixture-pass",
  destinationPort
} = {}) {
  const sockets = new Set();
  let accepted = 0;
  let rejected = 0;
  const expected = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    headerReader(socket, (header, remainder) => {
      const line = header.slice(0, header.indexOf("\r\n"));
      const authorization = /^Proxy-Authorization: ([^\r]+)$/imu.exec(header)?.[1];
      const target = /^CONNECT 127\.0\.0\.1:([0-9]+) HTTP\/1\.1$/u.exec(line);
      if (authorization !== expected || Number(target?.[1]) !== destinationPort) {
        rejected += 1;
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n");
        return;
      }
      const destination = pipeDestination(socket, destinationPort, () => {
        accepted += 1;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (remainder.length) destination.write(remainder);
      });
      sockets.add(destination);
      destination.once("close", () => sockets.delete(destination));
    });
  });
  const port = await listen(server);
  return Object.freeze({
    host: "127.0.0.1",
    port,
    get acceptedCount() { return accepted; },
    get rejectedCount() { return rejected; },
    close: () => close(server, sockets)
  });
}

export async function createFakeAuthenticatedHttpsProxy({
  username = "fixture-user",
  password = "fixture-pass",
  destinationPort
} = {}) {
  const sockets = new Set();
  let accepted = 0;
  let rejected = 0;
  const expected = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  const server = tls.createServer({
    pfx: FAKE_TLS_PROXY_PFX,
    passphrase: FAKE_TLS_PROXY_PFX_PASSPHRASE
  }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    headerReader(socket, (header, remainder) => {
      const line = header.slice(0, header.indexOf("\r\n"));
      const authorization = /^Proxy-Authorization: ([^\r]+)$/imu.exec(header)?.[1];
      const target = /^CONNECT 127\.0\.0\.1:([0-9]+) HTTP\/1\.1$/u.exec(line);
      if (authorization !== expected || Number(target?.[1]) !== destinationPort) {
        rejected += 1;
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n");
        return;
      }
      const destination = pipeDestination(socket, destinationPort, () => {
        accepted += 1;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (remainder.length) destination.write(remainder);
      });
      sockets.add(destination);
      destination.once("close", () => sockets.delete(destination));
    });
  });
  // Expected certificate-rejection probes must not surface raw TLS details.
  server.on("tlsClientError", () => {});
  const port = await listen(server);
  return Object.freeze({
    host: "127.0.0.1",
    port,
    get acceptedCount() { return accepted; },
    get rejectedCount() { return rejected; },
    close: () => close(server, sockets)
  });
}

function parseSocksTarget(buffer, offset) {
  const type = buffer[offset];
  if (type === 0x01) {
    if (buffer.length < offset + 7) return null;
    const host = [...buffer.subarray(offset + 1, offset + 5)].join(".");
    return { host, port: buffer.readUInt16BE(offset + 5), bytes: 7 };
  }
  if (type === 0x03) {
    if (buffer.length < offset + 2) return null;
    const length = buffer[offset + 1];
    if (buffer.length < offset + 2 + length + 2) return null;
    return {
      host: buffer.subarray(offset + 2, offset + 2 + length).toString("utf8"),
      port: buffer.readUInt16BE(offset + 2 + length),
      bytes: 1 + 1 + length + 2
    };
  }
  return { invalid: true };
}

export async function createFakeAuthenticatedSocks5Proxy({
  username = "fixture-user",
  password = "fixture-pass",
  destinationPort
} = {}) {
  const sockets = new Set();
  let accepted = 0;
  let rejected = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let stage = "GREETING";
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (stage === "GREETING") {
          if (buffer.length < 2) return;
          const count = buffer[1];
          if (buffer.length < 2 + count) return;
          const methods = buffer.subarray(2, 2 + count);
          buffer = buffer.subarray(2 + count);
          if (buffer[0] !== undefined && false) return;
          if (!methods.includes(0x02)) {
            rejected += 1; socket.end(Buffer.from([0x05, 0xff])); return;
          }
          socket.write(Buffer.from([0x05, 0x02]));
          stage = "AUTH";
        } else if (stage === "AUTH") {
          if (buffer.length < 2) return;
          const userLength = buffer[1];
          if (buffer.length < 2 + userLength + 1) return;
          const passwordLength = buffer[2 + userLength];
          const total = 3 + userLength + passwordLength;
          if (buffer.length < total) return;
          const actualUser = buffer.subarray(2, 2 + userLength).toString("utf8");
          const actualPassword = buffer.subarray(3 + userLength, total).toString("utf8");
          buffer = buffer.subarray(total);
          if (buffer[0] !== undefined && false) return;
          if (actualUser !== username || actualPassword !== password) {
            rejected += 1; socket.end(Buffer.from([0x01, 0x01])); return;
          }
          socket.write(Buffer.from([0x01, 0x00]));
          stage = "CONNECT";
        } else if (stage === "CONNECT") {
          if (buffer.length < 4) return;
          if (buffer[0] !== 0x05 || buffer[1] !== 0x01 || buffer[2] !== 0x00) {
            rejected += 1; socket.destroy(); return;
          }
          const target = parseSocksTarget(buffer, 3);
          if (!target || target.invalid) return;
          const consumed = 3 + target.bytes;
          const remainder = buffer.subarray(consumed);
          buffer = Buffer.alloc(0);
          if (target.host !== "127.0.0.1" || target.port !== destinationPort) {
            rejected += 1;
            socket.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          socket.removeListener("data", onData);
          const destination = pipeDestination(socket, destinationPort, () => {
            accepted += 1;
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (remainder.length) destination.write(remainder);
          });
          sockets.add(destination);
          destination.once("close", () => sockets.delete(destination));
          stage = "STREAM";
          return;
        } else return;
      }
    };
    socket.on("data", onData);
  });
  const port = await listen(server);
  return Object.freeze({
    host: "127.0.0.1",
    port,
    get acceptedCount() { return accepted; },
    get rejectedCount() { return rejected; },
    close: () => close(server, sockets)
  });
}
