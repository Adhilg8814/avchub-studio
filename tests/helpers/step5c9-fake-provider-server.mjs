// Provider-free loopback HTTP fixture for Step 5C.9A media tests.
// Binds only 127.0.0.1, records no headers, and owns every byte it serves.

import http from "node:http";

function box(type, payload = Buffer.alloc(0), { sizeToEnd = false, extended = false } = {}) {
  if (!/^[\x20-\x7e]{4}$/.test(type)) throw new Error("test box type must be four printable bytes");
  if (sizeToEnd) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0, 0);
    header.write(type, 4, 4, "ascii");
    return Buffer.concat([header, payload]);
  }
  if (extended) {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write(type, 4, 4, "ascii");
    header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

export function makeSyntheticMp4({ totalBytes = 40 * 1024, extendedMdat = false, mdatToEnd = false } = {}) {
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write("isom", 0, 4, "ascii");
  ftypPayload.writeUInt32BE(0x200, 4);
  ftypPayload.write("isom", 8, 4, "ascii");
  ftypPayload.write("mp42", 12, 4, "ascii");
  const ftyp = box("ftyp", ftypPayload);
  const moov = box("moov", box("mvhd", Buffer.alloc(20)));
  const mdatHeaderBytes = extendedMdat ? 16 : 8;
  const fixed = ftyp.length + moov.length + mdatHeaderBytes;
  const payloadBytes = Math.max(1, totalBytes - fixed);
  const payload = Buffer.alloc(payloadBytes, 0x5a);
  const mdat = box("mdat", payload, { extended: extendedMdat, sizeToEnd: mdatToEnd });
  return Buffer.concat([ftyp, moov, mdat]);
}

export async function createFakeProviderServer() {
  const valid = makeSyntheticMp4();
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    requests.push({ method: req.method, path: requestUrl.pathname });
    switch (requestUrl.pathname) {
      case "/video":
        res.writeHead(200, { "content-type": "video/mp4", "content-length": String(valid.length) });
        res.end(valid);
        break;
      case "/chunked":
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.write(valid.subarray(0, 1000));
        setImmediate(() => res.end(valid.subarray(1000)));
        break;
      case "/redirect":
        res.writeHead(302, { location: "/video" });
        res.end();
        break;
      case "/redirect-other-host":
        res.writeHead(302, { location: `http://localhost:${server.address().port}/video` });
        res.end();
        break;
      case "/redirect-loop":
        res.writeHead(302, { location: "/redirect-loop" });
        res.end();
        break;
      case "/html":
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><html><body>not video</body></html>");
        break;
      case "/html-as-binary":
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.concat([Buffer.from("<!doctype html>"), Buffer.alloc(40 * 1024)]));
        break;
      case "/malformed": {
        const malformed = Buffer.from(valid);
        malformed.writeUInt32BE(0x7fffffff, 0);
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(malformed);
        break;
      }
      case "/short":
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(valid.subarray(0, 1000));
        break;
      case "/advertised-oversize":
        res.writeHead(200, { "content-type": "video/mp4", "content-length": String(513 * 1024 * 1024) });
        res.end();
        break;
      case "/stream-oversize":
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(makeSyntheticMp4({ totalBytes: 48 * 1024 }));
        break;
      case "/slow":
        res.writeHead(200, { "content-type": "video/mp4" });
        res.write(valid.subarray(0, 100));
        setTimeout(() => { if (!res.destroyed) res.end(valid.subarray(100)); }, 500).unref?.();
        break;
      case "/status":
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("unavailable");
        break;
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("missing");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    valid,
    url(pathname) { return `${origin}${pathname}`; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
