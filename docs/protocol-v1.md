# AVCHub Studio — Worker Protocol v1

> **Trạng thái:** Protocol v1 + Worker runtime **đã implement & test locally** (envelope/
> message-types/ids/errors ở `lib/protocol/*`; WorkerRuntime; recovery journal + contract
> `lib/worker/recovery-*.mjs`; WebSocket transport local `lib/worker/transports/*` +
> `lib/control/local-control-plane.mjs`; pairing + credential lifecycle). **Production Control
> Plane persistence (PostgreSQL inbox/outbox/ACK ledger) + deployment CHƯA implement** — thiết
> kế ở Step 5C ([control-plane-architecture.md](control-plane-architecture.md),
> [control-plane-postgres-schema.md](control-plane-postgres-schema.md)). Đồng bộ với
> [local-first-saas-architecture.md](local-first-saas-architecture.md) và
> [p0-worker-extraction-plan.md](p0-worker-extraction-plan.md).
> **protocolVersion:** `1`. Đây là hợp đồng giữa **Cloud Control Plane** và **Studio Worker**.
> Ngữ nghĩa recovery (SUBMITTING, submission evidence, generationOrdinal, golden rule,
> resume/recover, drain vs stop) do [recovery-contract.md](recovery-contract.md) **sở hữu**;
> tài liệu này KHÔNG định nghĩa một state machine recovery thứ hai.

---

## 1. Transport

| Kênh | Dùng cho | Ghi chú |
|---|---|---|
| **WSS** `wss://<worker-gateway-host>/ws/worker` | Toàn bộ job lifecycle, heartbeat, event | Worker mở **outbound**; bền; auto-reconnect |
| **HTTPS** `POST /worker/pair` | Pairing (đổi code lấy credential) | Một lần, trước khi có WSS |
| **HTTPS** `POST /worker/recover` | Recovery khi WSS không ổn định | Idempotent; trả trạng thái job phía cloud |
| **HTTPS** `GET /worker/time` | Đồng bộ đồng hồ (chống replay) | Trả `serverTime` |
| Long-poll `GET/POST /worker/poll` | **Fallback** khi WSS bị firewall chặn | Cùng envelope; chỉ bật khi cần |

**Nguyên tắc:** media KHÔNG đi qua WSS. Metadata + progress qua WSS; file transfer (khi cần P3 backup) qua HTTPS presigned URL riêng.

Cloud **không bao giờ** cần inbound vào LAN Worker.

**Endpoint host (environment-neutral — KHÔNG hardcode; không provision ở task này):**
`<worker-gateway-host>` phân giải theo môi trường —
- local/dev: `ws://127.0.0.1:<port>/ws/worker` (loopback, `ws://` test-only);
- staging: `wss://worker-staging.example.com/ws/worker`;
- production: `wss://<worker-gateway-host>/ws/worker` (chưa cấu hình).

**Dedupe & persistence — hai tầng (đừng nhầm):**
- **Worker/local (tối ưu):** LRU in-memory ~10k `messageId` gần nhất chỉ là **tối ưu**, mất khi restart.
- **Production Control Plane (đúng đắn):** dedupe **bền** qua `protocol_inbox` (`UNIQUE(worker_id, message_id)`) + **tombstone** giữ sau khi sweep payload; đây mới là nguồn đảm bảo exactly-once, sống sót qua restart. Thứ tự nhận production (arch §11.2): **dedupe TRƯỚC skew** — xem §5.4.

---

## 2. Authentication

- **Pairing (HTTPS):** Worker gửi `pairingCode` (một lần) → nhận `workerCredential` (token dài hạn) + `workerId`.
- **WSS handshake:** Worker gửi `workerCredential` **CHỈ** trong header `Authorization: Bearer <credential>` khi mở WSS. **KHÔNG** được đặt credential trong payload `WORKER_HELLO` (hay bất kỳ message nào) — điều này giữ credential ra khỏi log message, cho phép cloud đóng kết nối sớm nếu sai, và tránh credential lọt vào envelope validation/dedupe/replay store. Cloud verify hash → gắn `workerId`+`workspaceId` vào kết nối; `WORKER_HELLO` chỉ khai báo version/capabilities/storage (không credential).
- **Mọi message** trên kết nối kế thừa danh tính đã auth. Server **derive** `workerId`+`workspaceId` từ credential đã auth. Field `workerId`/`workspaceId` trong message **phải khớp** danh tính kết nối; nếu **khác** → **KHÔNG silent override**. Server: (1) **reject** message; (2) trả `E_IDENTITY_MISMATCH`; (3) ghi `audit_events`; (4) tăng **protocol-violation counter**; (5) **đóng kết nối** sau nhiều lần lệch, hoặc **ngay** nếu lệch nghiêm trọng (`workspaceId` khác workspace của credential). Xem [§10 Security](#10-security-requirements-protocol-level).
- Credential lưu trên Worker bằng **Windows Credential Manager / DPAPI**. Không plaintext/log/arg.

---

## 3. Message envelope

```jsonc
{
  "protocolVersion": 1,
  "messageId": "msg_01JQ7ZK9M3N4P5Q6R7S8T9V0A1",   // prefix + 26-char ULID (Crockford base32, không I/L/O/U)
  "type": "JOB_OFFER",                              // enum (bảng §5)
  "userId": "usr_01JQ7ZK9M3N4P5Q6R7S8T9V0A2",       // optional (message hệ thống có thể trống)
  "workspaceId": "ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3",   // BẮT BUỘC trên message có ngữ cảnh workspace
  "workerId": "wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",     // bắt buộc trên message liên quan Worker
  "jobId": "job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5",        // bắt buộc trên message job
  "sentAt": "2026-07-12T01:00:00.000Z",             // ISO-8601 UTC ms
  "correlationId": "corr_01JQ7ZK9M3N4P5Q6R7S8T9V0E6", // nối request↔response/event
  "payload": { }
}
```

### Ràng buộc field
| Field | Bắt buộc | Kiểu | Ràng buộc |
|---|---|---|---|
| protocolVersion | ✔ | int | == 1; major mismatch → reject |
| messageId | ✔ | string | `msg_` + ULID (26 char); duy nhất; dedupe key |
| type | ✔ | enum | thuộc §5; unknown → `ERROR` (không đóng kết nối) |
| userId | tùy | string | `usr_` + ULID |
| workspaceId | ✔* | string | `ws_` + ULID; *bắt buộc mọi message ngữ cảnh |
| workerId | ✔* | string | `wrk_` + ULID |
| jobId | ✔* | string | `job_` + ULID |
| sentAt | ✔ | string | ISO-8601 UTC ms; lệch server > 120s → reject (replay) |
| correlationId | tùy | string | `corr_` + ULID |
| payload | ✔ | object | schema theo `type`; ≤ 256 KB (asset batch ≤ 1 MB) |

### Quy tắc chung
- **ID format:** prefix + [ULID](https://github.com/ulid/spec) (26 ký tự Crockford base32, sortable, không đoán được).
- **Timestamp:** UTC millisecond; server là nguồn chân lý thời gian (`GET /worker/time`).
- **Version compat:** cùng major (1) bắt buộc. Bên nhận **bỏ qua field lạ** (forward-compat minor). Thêm message type mới trong v1 = minor; xóa/đổi nghĩa = major mới.
- **Payload validation:** strict JSON schema; reject field lạ ở payload job; oversize → `ERROR E_PAYLOAD_TOO_LARGE`.
- **Unknown message type:** log + trả `ERROR{code:E_UNKNOWN_TYPE}`; **không** đóng kết nối.
- **Replay protection:** `messageId` unique (LRU cache phía nhận ~10k gần nhất) + `sentAt` window ±120s.
- **Dedupe:** message trùng `messageId` → idempotent. Worker-local: bỏ qua. **Production Control Plane: replay `MESSAGE_ACK` đã cache** (không chỉ "drop") để bên gửi biết đã xử lý — xem §5.4.
- **Acknowledgement:** dùng **một cơ chế duy nhất** là message type `MESSAGE_ACK` (định nghĩa đầy đủ tại [§5.1](#51-message_ack--cơ-chế-ack-duy-nhất)). KHÔNG dùng `ack:true`/`*_ACK` rời rạc. Event stream (`JOB_PROGRESS`) dùng `sequence`, không cần ack từng cái.
- **Error envelope:** `type:"ERROR"`, `payload:{code, message, retriable:bool, correlationId}`.

---

## 4. Connection lifecycle (chi tiết)

```
Worker                                            Cloud
  │  (đã có credential)                             │
  │══ WSS connect (Authorization: Bearer cred) ════►│ verify hash → gắn workerId/workspaceId
  │── WORKER_HELLO {protocolVersion, workerVersion, │
  │   capabilities, storage} ──────────────────────►│
  │◄─ HELLO_ACK {sessionId, serverTime,             │ nếu version major sai → ERROR + close
  │   negotiatedProtocolVersion, resumeToken} ──────│
  │── WORKER_CAPABILITIES / WORKER_STORAGE_STATUS ─►│ cập nhật workers table
  │◄═ (nếu có job dở) STATE_RECONCILE_REQUEST ══════│
  │── STATE_RECONCILE (danh sách job local + journal)►│ đối chiếu jobs DB
  │◄─ MESSAGE_ACK {ackedType:"STATE_RECONCILE"} ─────│
  │── JOB_RECOVERY_REPORT (job có result chưa ack) ►│ chuyển SUCCEEDED, upsert asset
  │◄─ MESSAGE_ACK {ackedType:"JOB_RECOVERY_REPORT"} ─│ reconcile done (KHÔNG generation thứ hai)
  │↺ WORKER_HEARTBEAT mỗi 20s ─────────────────────►│ cập nhật last_seen_at
  │◄─ PING (nếu im lặng) ; Worker trả HEARTBEAT      │
  │◄─ JOB_OFFER ────────────────────────────────────│
  │── JOB_ACCEPTED / JOB_REJECTED ─────────────────►│
  │── JOB_STARTED → JOB_PROGRESS* ─────────────────►│ append job_events
  │── (JOB_NEEDS_MANUAL_ACTION) ───────────────────►│ status NEEDS_MANUAL_ACTION
  │── JOB_COMPLETED / JOB_FAILED ──────────────────►│ status + result/error
  │◄─ MESSAGE_ACK {ackedType:"JOB_COMPLETED"|"JOB_FAILED"} ─│
  │◄─ JOB_CANCEL_REQUEST ───────────────────────────│
  │── JOB_CANCELED ────────────────────────────────►│
  │◄─ MESSAGE_ACK {ackedType:"JOB_CANCELED"} ────────│
  │── WORKER_GOODBYE (graceful shutdown) ──────────►│ status OFFLINE
  │══ (disconnect) ═════════════════════════════════│ offline sau 90s miss heartbeat
```

**Heartbeat:** 20s. **Degraded:** 45s không HB. **Offline:** 90s. **Reconnect backoff:** 1,2,5,10,30s (+jitter), cap 30s. **Resume:** `resumeToken` trong `HELLO_ACK` cho phép cloud gắn lại session cũ + gửi event chưa ack.

---

## 5. Message types

### Worker → Cloud
| Type | Ý nghĩa | Cloud xác nhận bằng |
|---|---|---|
| `WORKER_HELLO` | Bắt đầu phiên, khai báo version/capabilities | `HELLO_ACK` |
| `WORKER_HEARTBEAT` | Nhịp sống + storage tóm tắt | (không) |
| `WORKER_CAPABILITIES` | Danh sách capability chi tiết | (không) |
| `WORKER_STORAGE_STATUS` | free/total bytes, root label, health | (không) |
| `JOB_ACCEPTED` | Nhận job | (không) |
| `JOB_REJECTED` | Từ chối job (kèm reason) | (không) |
| `JOB_STARTED` | Bắt đầu chạy | (không) |
| `JOB_PROGRESS` | Tiến độ (có `sequence`) | (không — dùng sequence) |
| `JOB_NEEDS_MANUAL_ACTION` | Cần login/verify tay | (không) |
| `JOB_COMPLETED` | Xong + result metadata | **`MESSAGE_ACK`** |
| `JOB_FAILED` | Lỗi + error code | **`MESSAGE_ACK`** |
| `JOB_CANCELED` | Đã hủy | **`MESSAGE_ACK`** |
| `JOB_RECOVERY_REPORT` | Báo cáo job local chưa ack sau reconnect | **`MESSAGE_ACK`** |
| `STATE_RECONCILE` | Toàn bộ trạng thái local (journal, job đang chạy, kết quả chờ ack) | **`MESSAGE_ACK`** (mỗi batch) |
| `PROVIDER_SESSION_STATUS` | Kết quả check session (không secret) | (không) |
| `ASSET_METADATA_UPSERT` | Metadata asset mới/đổi (không media) | **`MESSAGE_ACK`** |
| `MESSAGE_ACK` | Worker xác nhận một message quan trọng của cloud (vd `WORKER_CREDENTIAL_ROTATE`) — **ack đi cả 2 chiều** | — (không ack một ack) |
| `WORKER_GOODBYE` | Tắt graceful | (không) |

### Cloud → Worker
| Type | Ý nghĩa | Worker xác nhận bằng |
|---|---|---|
| `HELLO_ACK` | Xác nhận phiên + serverTime + resumeToken | — |
| `MESSAGE_ACK` | Xác nhận đã nhận & xử lý một message quan trọng (xem §5.1) | — |
| `JOB_OFFER` | Chào 1 job (allowlist) | `JOB_ACCEPTED`/`JOB_REJECTED` |
| `JOB_CANCEL_REQUEST` | Yêu cầu hủy | `JOB_CANCELED` |
| `SESSION_CHECK_REQUEST` | Yêu cầu check provider session | `PROVIDER_SESSION_STATUS` |
| `WORKER_CREDENTIAL_ROTATE` | Cấp credential mới | `MESSAGE_ACK` (Worker→Cloud) sau khi lưu |
| `WORKER_REVOKED` | Thu hồi Worker | Worker ngắt + xóa credential |
| `STATE_RECONCILE_REQUEST` | Yêu cầu đồng bộ job dở | `STATE_RECONCILE` |
| `PING` | Kiểm tra sống | `WORKER_HEARTBEAT` |

### 5.1 `MESSAGE_ACK` — cơ chế ack DUY NHẤT

Đây là **cơ chế xác nhận duy nhất** của protocol. KHÔNG dùng `ack:true` hay `*_ACK` riêng lẻ. Cả hai chiều đều có thể gửi `MESSAGE_ACK` để xác nhận một message quan trọng đã nhận và xử lý.

**Payload:**
```jsonc
{ "ackedMessageId": "msg_01JQ7ZK9M3N4P5Q6R7S8T9V0H8",  // messageId được ack (ULID hợp lệ)
  "ackedType": "JOB_COMPLETED",     // type của message được ack
  "status": "ACCEPTED",             // ACCEPTED | REJECTED | VALIDATION_FAILED
  "serverRevision": 129,            // (khi cloud ack metadata) revision sau khi áp dụng; null nếu N/A
  "errorCode": null }               // null nếu ACCEPTED; mã lỗi nếu REJECTED/VALIDATION_FAILED
```

**Bắt buộc `MESSAGE_ACK` cho tối thiểu:** `JOB_COMPLETED`, `JOB_FAILED`, `JOB_CANCELED`, `JOB_RECOVERY_REPORT`, `ASSET_METADATA_UPSERT`, `STATE_RECONCILE`, và Worker ack `WORKER_CREDENTIAL_ROTATE` sau khi lưu credential mới. **Ack đi cả hai chiều** (Worker→Cloud và Cloud→Worker).

**Payload rules:**
- `ackedMessageId` phải là `msg_` + ULID hợp lệ; `ackedType` phải là **một protocol type đã biết**.
- `status:"ACCEPTED"` → `errorCode` phải `null`. `status:"REJECTED"`/`"VALIDATION_FAILED"` → `errorCode` là chuỗi mã lỗi an toàn (không echo secret).
- `serverRevision` là số nguyên hoặc `null`.
- **KHÔNG ack một `MESSAGE_ACK`:** `ackedType` không được là `MESSAGE_ACK` (mặc định reject) — chống vòng lặp ack vô hạn. Một `MESSAGE_ACK` không sinh ra ack khác.

**Semantics:**
- **Khi nào Worker được xóa dữ liệu journal "pending-ack":** chỉ sau khi nhận `MESSAGE_ACK{status:"ACCEPTED"}` cho message tương ứng (`ackedMessageId` khớp). Trước đó, Worker giữ kết quả trong `worker-state/recovery/` và replay sau reconnect.
- **Duplicate ACK:** nếu nhận `MESSAGE_ACK` cho message đã ack rồi → bỏ qua (idempotent, `ackedMessageId` dedupe).
- **ACK timeout:** bên gửi message quan trọng chờ ack trong **30s**; hết hạn → resend (cùng `messageId` để dedupe) tối đa **5 lần** với backoff; vẫn thất bại → giữ pending-ack, replay khi reconnect.
- **Replay sau reconnect:** sau `WORKER_HELLO`, Worker replay mọi message pending-ack (kết quả terminal, asset upsert) với **cùng `messageId`**; cloud dedupe theo `messageId`, ack lại.
- **Rejection ACK (`status:"REJECTED"`):** cloud từ chối message (vd job không tồn tại / đã terminal khác) → Worker ghi log, **không** replay vô hạn; đưa vào diagnostics.
- **Validation failure (`status:"VALIDATION_FAILED"` + `errorCode`):** payload sai schema → bên gửi **không** resend nguyên trạng (sẽ lại fail); ghi diagnostics + surface lỗi; **không** làm mất kết quả media local (giữ file, đánh dấu cần thao tác tay).

### 5.2 `STATE_RECONCILE` (Worker → Cloud) — đầy đủ

Gửi để trả lời `STATE_RECONCILE_REQUEST` (hoặc chủ động sau `WORKER_HELLO` khi có việc dở). Mang **toàn bộ trạng thái local** cần đối chiếu.

**Payload:**
```jsonc
{
  "reconcileId": "corr_01JQ7ZK9M3N4P5Q6R7S8T9V0R5",  // gộp các batch cùng lần reconcile
  "batch": { "index": 0, "total": 1, "isLast": true }, // batching khi list lớn
  "workerClock": "2026-07-12T01:05:00.000Z",           // local timestamp lúc chụp
  "lastEventSequenceByJob": { "job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5": 8 }, // event sequence cuối đã gửi/ghi
  "activeJobs": [
    { "jobId": "job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "action": "GENERATE_GROK_VIDEO",
      "localStatus": "RUNNING", "phase": "WAITING_FOR_RESULT",
      "submittedToProvider": true, "providerSubmissionId": "submission_01JQ7ZK9M3N4P5Q6R7S8T9V0S6",
      "acceptedBaseRevision": 128, "startedAt": "2026-07-12T01:01:00.000Z" }
  ],
  "terminalPendingAck": [
    { "jobId": "job_01JQ7ZK9M3N4P5Q6R7S8T9V0E7", "terminalType": "JOB_COMPLETED",
      "originalMessageId": "msg_01JQ7ZK9M3N4P5Q6R7S8T9V0T7",
      "submittedToProvider": true,
      "localResultRef": "recovery/job_01JQ7ZK9M3N4P5Q6R7S8T9V0E7.json",
      "importedAssetId": "asset_01JQ7ZK9M3N4P5Q6R7S8T9V0V8",
      "result": { "checksum": "sha256:9f2c...", "sizeBytes": 3082866,
        "relativePath": "episodes/EP01/videos/EP01_sh_..._GROK_asset_....mp4" },
      "finishedAt": "2026-07-12T01:03:10.000Z" }
  ],
  "journalDigest": { "totalEntries": 12, "oldestJobId": "job_...", "newestJobId": "job_..." }
}
```

**Nội dung bắt buộc:** journal entries (tóm tắt qua `activeJobs` + `terminalPendingAck` + `journalDigest`); active jobs; terminal results chờ ack; `submittedToProvider` state; local result references; imported asset IDs; last event `sequence` mỗi job; local timestamps.

**Payload limit & batching:** mỗi `STATE_RECONCILE` ≤ **1 MB**. Nếu danh sách vượt: chia batch (`batch.index/total/isLast`), cùng `reconcileId`; cloud ack **từng batch** bằng `MESSAGE_ACK`; chỉ coi reconcile hoàn tất khi nhận batch `isLast:true` + ack. Ưu tiên `terminalPendingAck` (chống mất kết quả) trước, `activeJobs` sau.

**Cloud xử lý:** với mỗi `terminalPendingAck` — nếu job phía cloud vẫn `RUNNING`/`DISPATCHED` → chuyển theo `terminalType`, upsert asset (áp [ma trận source-of-truth](local-first-saas-architecture.md): nhận media facts, không đè metadata cộng tác mới hơn theo `acceptedBaseRevision`), `createdSecondGeneration:false`. Với `activeJobs` có `submittedToProvider:true` → **tuyệt đối không re-dispatch** (chống double-charge); chờ job hoàn tất tự nhiên.

---

### 5.3 Worker recovery journal & pending-ack (P0 Step 3 — local durability)

Đây là **trạng thái local của Worker** (không phải message wire), nhưng quyết định nội dung `STATE_RECONCILE`/`JOB_RECOVERY_REPORT` ở trên. Modules: `lib/worker/recovery-journal.mjs`, `pending-ack-store.mjs`, `progress-adapter.mjs`, `reconcile-builder.mjs`, `recovery-classifier.mjs`, `journal-safety.mjs`.

**Recovery journal — quyền sở hữu & bất biến an toàn.** Filesystem-backed dưới một root cấu hình được (`<root>/journal/<jobId>.json`, một record/job). Ghi **atomic** (temp-file + rename) → crash giữa chừng không để lại JSON dở. Tên file suy ra **chỉ từ `jobId` đã validate** (`job_<ULID>`) nên không thể path-traversal. `schemaVersion` strict (mismatch → quarantine). Record **KHÔNG BAO GIỜ** chứa password/cookie/token/proxy/fingerprint (chặn ở mọi độ sâu, mọi hoa/thường), **không** absolute path, **không** browser-profile path, **không** raw provider URL; `localResultRef` phải là **relative ref** (không `..`, không drive letter, không scheme); result metadata chỉ giữ `{checksum, sizeBytes, relativePath, durationSec?, width?, height?, mimeType?}`. Error đã **sanitize** thành `{code, message}` (chỉ ProtocolError/WorkerError mới lộ message; còn lại → generic). Record hỏng bị **quarantine** (`<root>/quarantine/…`) chứ không âm thầm bỏ qua. Listing **deterministic** (sort theo jobId). Mọi timestamp **UTC ISO-8601**; clock **inject được** để test xác định.
API: `create · read · update · markRunning · markSubmitted · markProgress · markLocalResult · markTerminal · markAckPending · markAcknowledged · list · listRecoverable · remove · quarantine · sweep`.

**Pending-ack store — vòng đời.** Persist các message Worker→Cloud quan trọng (`JOB_COMPLETED, JOB_FAILED, JOB_CANCELED, JOB_RECOVERY_REPORT, STATE_RECONCILE, ASSET_METADATA_UPSERT`) tới khi nhận `MESSAGE_ACK{status:"ACCEPTED"}`. `MESSAGE_ACK` **không bao giờ** được persist để chờ-ack (không ack-loop). Ack `REJECTED`/`VALIDATION_FAILED` → chuyển sang `diagnostics/` (không tự resend ở step này — **không có retry timer**). Persistence chỉ bị xóa **sau** khi `ACCEPTED`. API: `put · get · has · list · onAck · markAcknowledged · remove`.

**Thứ tự durability khi terminal:** WorkerRuntime **mark terminal trong journal + put terminal envelope vào pending-ack TRƯỚC khi publish**; khi nhận `MESSAGE_ACK ACCEPTED` → xóa pending-ack + `markAcknowledged` journal.

**Recovery classification (`classifyRecovery(record)`).** Suy ra hành động phục hồi an toàn:

| State | Ý nghĩa | Auto-retry (tốn quota)? |
|---|---|---|
| `NOT_SUBMITTED_SAFE_TO_RETRY` | chưa submit provider | **CÓ** (chỉ trạng thái này) |
| `SUBMITTED_WAIT_FOR_PROVIDER` | đã submit, chờ kết quả | không — chờ/thu lại |
| `SUBMITTED_RESULT_AVAILABLE` | kết quả có ở provider, chưa tải | không — tải lại |
| `DOWNLOADED_NOT_IMPORTED` | đã tải local, chưa import | không — import lại |
| `IMPORTED_NOT_ACKNOWLEDGED` | đã import, cloud chưa ack | không — báo cáo lại |
| `TERMINAL_PENDING_ACK` | terminal chưa được ack | không — re-deliver |
| `MANUAL_ACTION_REQUIRED` | cần operator (vd verify) | không |
| `CORRUPT_JOURNAL` | record hỏng, đã quarantine | không — operator |
| `UNKNOWN_NEEDS_OPERATOR` | không phân loại được | không — operator |
| `SETTLED` | terminal đã ack — hết việc (không recover) | — |

**Quy tắc no-auto-resubmit (tối quan trọng):** `canAutoRetryGeneration(record)` **luôn `false` khi `submittedToProvider === true`**. `recoverJobs()` đọc journal và trả **candidate có cấu trúc** nhưng **KHÔNG BAO GIỜ tự chạy** job đã `submittedToProvider=true`; sinh lại tốn phí chỉ xảy ra khi **user xác nhận** (tạo `generationAttemptId` mới). `canRecoverWithoutNewGeneration(record)` true cho các state submitted/downloaded/imported/terminal-pending-ack.

**Retention:** active/recoverable giữ lại; terminal-đã-ack (`SETTLED`) giữ ngắn để chẩn đoán rồi `sweep` (clock inject được) hoặc xóa tường minh; pending-ack chỉ xóa sau `ACCEPTED`; corrupt → quarantine/diagnostics; **không tự xóa media** bao giờ.

---

### 5.4 Production persistence: inbox/outbox + settlement (Step 5C — thiết kế)

Bản địa hoá WSS ở trên là **local**. Bản production Control Plane thay các map in-memory
bằng bảng bền (thiết kế: [control-plane-architecture.md §11–§12](control-plane-architecture.md),
[schema §Protocol](control-plane-postgres-schema.md)). Hợp đồng wire (§3, §5) **không đổi**;
đây là ngữ nghĩa persistence/settlement mà production phải theo.

**Thứ tự nhận (production, worker→cloud) — dedupe TRƯỚC skew:**
1. parse + size/depth safety; 2. trích `messageId`; 3. **tra `protocol_inbox` `(worker_id,
message_id)`** → nếu trùng: **replay ACK đã cache**, KHÔNG áp business; 4. chỉ với message
mới: kiểm `sentAt` ±120s; 5. validate identity/direction/schema (gồm **assigned-worker gate**:
`job.assigned_worker_id == derived worker`); 6. **một transaction**: insert inbox
(`UNIQUE(worker_id, message_id)`) + áp business + ghi ACK. `sentAt` **không** phải khoá
dedupe/bảo mật bền; replay dùng **cùng `messageId`** nhưng **re-stamp `sentAt`**.

**Outbox settlement (`settlement_mode`) — đừng gộp ACK / lifecycle response / send:**
- `MESSAGE_ACK` là **cơ chế ACK generic DUY NHẤT** (§5.1). `JOB_ACCEPTED`/`JOB_REJECTED` là
  **lifecycle response**, KHÔNG phải message ACK riêng.
- Mỗi outbox row có `settlement_mode ∈ {MESSAGE_ACK, LIFECYCLE_RESPONSE, SEND_ONLY}`:
  - `MESSAGE_ACK` — settle bởi `MESSAGE_ACK{ACCEPTED, ackedMessageId}` (vd `WORKER_CREDENTIAL_ROTATE`,
    và mọi message trong `ACK_REQUIRING_TYPES` của `message-types.mjs`).
  - `LIFECYCLE_RESPONSE` — settle bởi response tương quan đã validate: `JOB_OFFER`→
    `JOB_ACCEPTED`/`JOB_REJECTED`; `JOB_CANCEL_REQUEST`→`JOB_CANCELED`/đã-terminal;
    `STATE_RECONCILE_REQUEST`→chuỗi `STATE_RECONCILE` batch `isLast`+ack; `SESSION_CHECK_REQUEST`→
    `PROVIDER_SESSION_STATUS`.
  - `SEND_ONLY` — chỉ cho advisory không quan trọng (`PING`, `HELLO_ACK`, `MESSAGE_ACK`).
    **CẤM** cho paid-job ownership, cancel, credential lifecycle, terminal, reconcile.
- **Không** phải mọi outbox row cần `MESSAGE_ACK`. Single-flight per `(worker_id, job_id)` chờ
  **điều kiện settlement đúng của row trước**, không phải luôn là `MESSAGE_ACK` — nên một
  `JOB_CANCEL_REQUEST` KHÔNG bị kẹt vô hạn sau một `JOB_OFFER` (offer settle bằng
  accept/reject/expiry, bounded). Bảng đầy đủ per-type: [architecture §12.1](control-plane-architecture.md).

**Re-offer an toàn:** một attempt chỉ được re-offer khi offer **chưa từng gửi** (outbox còn
`PENDING`); offer đã `SENT` mà chưa accept → reconcile, **không** auto re-offer (arch §6.2).
`duplicate messageId` → **không chỉ "drop"**: production **replay ACK đã cache** (idempotent),
để bên gửi biết đã xử lý.

---

## 6. Job actions (chi tiết mỗi action)

Tất cả action thuộc allowlist. Input **chỉ** id + option enum. Worker resolve path từ id. **Không** path/cmd/executable/browser-arg/secret.

> **Canonical JOB_OFFER shape (P0 Step 3 — MỘT shape duy nhất).** Danh tính request nằm ở **cấp `payload`** của `JOB_OFFER`, KHÔNG nằm trong `input`:
> `payload = { action, requestIdempotencyKey, generationAttemptId, parentAttemptId?, retryOfJobId?, quotaRisk, expiresAt?, acceptedBaseRevision?, input }`.
> `input` chỉ chứa **dữ liệu nghiệp vụ của action** (`baseRevision` ở lại trong `input` vì action chạy trên đúng snapshot đó). Validator (`validateJobOffer`) **từ chối** `requestIdempotencyKey`/`generationAttemptId`/`parentAttemptId`/`retryOfJobId` nếu chúng xuất hiện trong `input` (→ `E_INVALID_JOB_INPUT`), và bắt buộc `req_`/`attempt_` ở payload cho mọi generation action. Không có shape kép/tương thích ngược.

### `GENERATE_GROK_VIDEO` (đại diện đầy đủ)
- **Input bắt buộc:** `projectId, episodeId, shotId, providerAccountId, promptSnapshot, sourceKeyframeAssetId`.
- **Input tùy chọn (duration capability-driven — xem [architecture §E.1](local-first-saas-architecture.md)):**
  - `requestedDurationSec ∈ {6, 10, 15}` — **default 10**.
  - `allowShortFallback` (bool) — **default false**; nếu `false`, KHÔNG âm thầm tụt về 6s.
  - `aspect` = `"9:16"` (cố định).
- **Cấm:** bất kỳ path, command, cookie, token, browser arg, output path.
- **Validation (TRƯỚC khi submit provider):** mọi id khớp `^[a-z0-9][a-z0-9-]{1,79}$`; `sourceKeyframeAssetId` phải là ảnh đã **approved/selected** của shot; `providerAccountId` là GROK, `sessionStatus=LOGGED_IN`, `profileName` hợp lệ; prompt ≤ 4000 char; **`requestedDurationSec` phải nằm trong `capabilities.supportedDurationsSec` của profile/model** — nếu không (vd yêu cầu 15 nhưng profile chỉ hỗ trợ 10) → **reject** `E_DURATION_OPTION_UNAVAILABLE`, **không tốn quota**, cho operator mở Grok thủ công; **không** âm thầm tạo 6s.
- **Result phân biệt 3 duration:** `requestedDurationSec`, `confirmedUiDurationSec` (đọc từ UI Grok trước submit; `null` nếu không đọc được), `actualDurationSec` (đo từ MP4). Nếu lệch đáng kể → đánh dấu `DURATION_MISMATCH`: giữ/import variant, **không** auto-approve, **không** auto-regenerate, cần operator xử lý.
- **Capability:** `grok.video`.
- **Quota:** **CÓ** (`quotaRisk=true`).
- **Output metadata:** result-level `duration:{requestedDurationSec, confirmedUiDurationSec, actualDurationSec, durationMismatch}` + asset `{assetId, relativePath, fileName, mimeType:"video/mp4", sizeBytes, checksum, actualDurationSec, provider:"GROK", providerAccountId, promptSnapshot, sourceAssetId}`.
- **Progress events:** map từ `grok-video-browser.py` STATUS phase → `VALIDATING/OPENING_BROWSER/UPLOADING_SOURCE/SUBMITTING_PROMPT/WAITING_FOR_RESULT/DOWNLOADING/IMPORTING` (khớp `lib/grok-video.mjs`).
- **Error codes:** `E_KEYFRAME_MISSING, E_SESSION_EXPIRED, E_PROFILE_LOCKED, E_PROVIDER_UI_CHANGED, E_SUBMIT_FAILED, E_TIMEOUT, E_DOWNLOAD_FAILED, E_INVALID_MP4, E_DISK_FULL, E_MANUAL_REQUIRED, E_DURATION_OPTION_UNAVAILABLE`.
- **Idempotency:** `requestIdempotencyKey` (một-click) chống double-submit; `generationAttemptId` cho phép sinh biến thể mới có chủ đích (xem [architecture §J](local-first-saas-architecture.md)). Worker journal nhớ `submittedToProvider` + `providerSubmissionId`; job đã submit + có file → **không** submit lại (recovery, không phí).
- **Cancel:** kill child + đóng browser job đó; giữ file đã tải; ack `JOB_CANCELED`.

**Các action khác** theo cùng khung (input/validation/output/progress/error/quota/idempotent/cancel — bảng tổng ở [architecture §E](local-first-saas-architecture.md)):
- `GENERATE_CHATGPT_IMAGE` — quota; ref `provider-smoke.py`/`generate-images.py`; error `E_COMPOSER_NOT_FOUND, E_IMAGE_FILTERED`.
- `GENERATE_GROK_IMAGE` — quota; thao tác tay hiện tại → handler mở provider + import (MVP có thể là manual-assist).
- `CHECK_PROVIDER_SESSION` — không quota; ref `provider-session.py --mode check`; output `sessionStatus`.
- `OPEN_PROVIDER_LOGIN` / `OPEN_PROVIDER` — không quota; mở browser visible; không nhận credential.
- `IMPORT_MEDIA` — không quota; import file operator đã có (manual fallback) qua `transferRef` (id file tạm Worker), không absolute path.
- `EXPORT_PROJECT` — không quota; `lib/video-export.mjs`; output package path relative.
- `STORAGE_SCAN` / `CLEANUP_DRY_RUN` — không quota; chỉ đọc; output danh sách.
- `CREATE_PROJECT_ARCHIVE` / `IMPORT_PROJECT_ARCHIVE` — không quota; checksum verify.

---

## 7. JSON examples (đầy đủ 11 luồng)

> **Bộ ID cố định dùng chung mọi ví dụ (fixture-ready, ULID hợp lệ):** `usr_01JQ7ZK9M3N4P5Q6R7S8T9V0A2`, `ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3`, `wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4`, `prj_01JQ7ZK9M3N4P5Q6R7S8T9V0F6`, `ep_01JQ7ZK9M3N4P5Q6R7S8T9V0G7`, `sh_01JQ7ZK9M3N4P5Q6R7S8T9V0H8`, `pa_01JQ7ZK9M3N4P5Q6R7S8T9V0J9`, `job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5`, keyframe `asset_01JQ7ZK9M3N4P5Q6R7S8T9V0K0`, video mới `asset_01JQ7ZK9M3N4P5Q6R7S8T9V0M1`, `sess_01JQ7ZK9M3N4P5Q6R7S8T9V0N2`, `corr_01JQ7ZK9M3N4P5Q6R7S8T9V0E6`.

### 7.1 Worker connection
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0P3", "type":"WORKER_HELLO",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "sentAt":"2026-07-12T01:00:00.000Z",
  "payload":{ "workerVersion":"0.1.0", "platform":"win32", "osVersion":"10.0.19045",
    "architecture":"x64", "protocolVersion":1,
    "capabilities":["chatgpt.image","grok.image","grok.video","export.capcut","storage.scan"],
    "providerDurations":{ "grok.video":{ "supportedDurationsSec":[10,15], "defaultDurationSec":10,
      "durationSelectionMode":"UI_PRESET", "supportsDurationConfirmation":true, "supportsExtend":false } },
    "storage":{ "rootLabel":"D:\\AVCStudioData", "freeBytes":812345678901, "totalBytes":1000204886016 } } }
```
Cloud trả (`resumeToken` = chuỗi OPAQUE ngẫu nhiên, hết hạn ngắn, **không** phải credential — xem [§11](#11-resumetoken--vòng-đời--bảo-mật)):
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0Q4", "type":"HELLO_ACK",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "correlationId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0P3", "sentAt":"2026-07-12T01:00:00.100Z",
  "payload":{ "sessionId":"sess_01JQ7ZK9M3N4P5Q6R7S8T9V0N2", "serverTime":"2026-07-12T01:00:00.100Z",
    "negotiatedProtocolVersion":1,
    "resumeToken":"rt.v1.9Zt3xQ0pKfR7mB2wN8sD4hL1cV6yG5a",
    "resumeTokenExpiresAt":"2026-07-12T01:02:00.100Z",
    "hasPendingReconcile":false } }
```

### 7.2 Heartbeat
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0T7", "type":"WORKER_HEARTBEAT",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "sentAt":"2026-07-12T01:00:20.000Z",
  "payload":{ "activeJobs":["job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5"], "freeBytes":812000000000 } }
```

### 7.3 Grok-video job offer (cloud → worker) — default 10s
`requestIdempotencyKey` = 1 click = 1 key (chống double-submit); `generationAttemptId` = danh tính lần sinh; `parentAttemptId` ≠ null khi là "sinh biến thể khác" ([§idempotency](local-first-saas-architecture.md#j-idempotency--deduplication)).
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0V8", "type":"JOB_OFFER",
  "userId":"usr_01JQ7ZK9M3N4P5Q6R7S8T9V0A2", "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3",
  "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4", "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5",
  "correlationId":"corr_01JQ7ZK9M3N4P5Q6R7S8T9V0E6", "sentAt":"2026-07-12T01:01:00.000Z",
  "payload":{ "action":"GENERATE_GROK_VIDEO",
    "requestIdempotencyKey":"req_01JQ7ZK9M3N4P5Q6R7S8T9V0S6",
    "generationAttemptId":"attempt_01JQ7ZK9M3N4P5Q6R7S8T9V0W9",
    "parentAttemptId":null,
    "quotaRisk":true, "expiresAt":"2026-07-12T01:11:00.000Z", "acceptedBaseRevision":128,
    "input":{ "projectId":"prj_01JQ7ZK9M3N4P5Q6R7S8T9V0F6", "episodeId":"ep_01JQ7ZK9M3N4P5Q6R7S8T9V0G7",
      "shotId":"sh_01JQ7ZK9M3N4P5Q6R7S8T9V0H8", "providerAccountId":"pa_01JQ7ZK9M3N4P5Q6R7S8T9V0J9",
      "sourceKeyframeAssetId":"asset_01JQ7ZK9M3N4P5Q6R7S8T9V0K0",
      "promptSnapshot":"Slow cinematic camera push-in with subtle natural lighting movement, no text.",
      "requestedDurationSec":10, "allowShortFallback":false, "aspect":"9:16" } } }
```

### 7.4 Job acceptance
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0W9", "type":"JOB_ACCEPTED",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "correlationId":"corr_01JQ7ZK9M3N4P5Q6R7S8T9V0E6",
  "sentAt":"2026-07-12T01:01:00.300Z",
  "payload":{ "acceptedAt":"2026-07-12T01:01:00.300Z", "acceptedBaseRevision":128 } }
```

### 7.5 Progress
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0X0", "type":"JOB_PROGRESS",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "sentAt":"2026-07-12T01:01:40.000Z",
  "payload":{ "sequence":3, "phase":"WAITING_FOR_RESULT", "label":"Đang chờ Grok sinh video",
    "percent":40 } }
```

### 7.6 Manual action required
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0Y1", "type":"JOB_NEEDS_MANUAL_ACTION",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "sentAt":"2026-07-12T01:02:00.000Z",
  "payload":{ "sequence":4, "reason":"PROVIDER_VERIFICATION",
    "message":"Grok cần xác minh trong cửa sổ đang mở. Hoàn tất thủ công rồi thử lại.",
    "browserVisible":true } }
```

### 7.7 Successful completion — 3 duration fields phân biệt
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0Z2", "type":"JOB_COMPLETED",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "sentAt":"2026-07-12T01:03:10.000Z",
  "payload":{ "sequence":9, "acceptedBaseRevision":128,
    "duration":{ "requestedDurationSec":10, "confirmedUiDurationSec":10, "actualDurationSec":10.0,
      "durationMismatch":false },
    "result":{
      "asset":{ "assetId":"asset_01JQ7ZK9M3N4P5Q6R7S8T9V0M1", "kind":"video", "provider":"GROK",
        "providerAccountId":"pa_01JQ7ZK9M3N4P5Q6R7S8T9V0J9",
        "relativePath":"episodes/EP01/videos/EP01_sh_01JQ7ZK9M3N4P5Q6R7S8T9V0H8_GROK_asset_01JQ7ZK9M3N4P5Q6R7S8T9V0M1.mp4",
        "fileName":"EP01_sh_..._GROK_asset_....mp4", "mimeType":"video/mp4",
        "sizeBytes":3082866, "checksum":"sha256:9f2c...", "actualDurationSec":10.0,
        "sourceAssetId":"asset_01JQ7ZK9M3N4P5Q6R7S8T9V0K0", "promptSnapshot":"Slow cinematic camera push-in with subtle natural lighting movement, no text.",
        "reviewStatus":"PENDING", "selected":false, "approved":false } } } }
```
> `selected/approved=false` — **không auto-duyệt** (khớp `importGrokVideo`). Nếu `actualDurationSec` lệch đáng kể so với `requestedDurationSec` → set `duration.durationMismatch:true` + `reviewStatus:"DURATION_MISMATCH"`, vẫn import, **không** auto-approve/regenerate.

Cloud xác nhận bằng `MESSAGE_ACK`:
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0A3", "type":"MESSAGE_ACK",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "sentAt":"2026-07-12T01:03:10.200Z",
  "payload":{ "ackedMessageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0Z2", "ackedType":"JOB_COMPLETED",
    "status":"ACCEPTED", "serverRevision":129, "errorCode":null } }
```
> Chỉ SAU `MESSAGE_ACK{status:"ACCEPTED"}` này Worker mới được xóa dữ liệu pending-ack của job khỏi `worker-state/recovery/`.

### 7.8 Failed download với generated result PRESERVED (không phí sinh lại)
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0B4", "type":"JOB_FAILED",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "sentAt":"2026-07-12T01:03:00.000Z",
  "payload":{ "sequence":8, "errorCode":"E_DOWNLOAD_FAILED",
    "errorMessage":"Tải MP4 lỗi 403 qua cả 3 cách.",
    "recovery":{ "submittedToProvider":true, "resultUrlKnown":true,
      "canRecoverWithoutNewGeneration":true,
      "hint":"URL CDN còn sống — thử lại download KHÔNG tốn quota." } } }
```
> Cloud thấy `submittedToProvider:true` + `canRecoverWithoutNewGeneration:true` → **không** tự tạo generation mới; UI cho "Thử lại download" (không phí) và chỉ "Sinh lại" (có phí, `generationAttemptId` mới) khi user xác nhận.

### 7.9 Reconnect & recovery (không sinh lần thứ hai)
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0C5", "type":"JOB_RECOVERY_REPORT",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "correlationId":"corr_01JQ7ZK9M3N4P5Q6R7S8T9V0E6",
  "sentAt":"2026-07-12T01:05:00.000Z",
  "payload":{ "localState":"DOWNLOADED_NOT_ACKED", "submittedToProvider":true,
    "originalMessageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0Z2",
    "result":{ "asset":{ "assetId":"asset_01JQ7ZK9M3N4P5Q6R7S8T9V0M1",
      "relativePath":"episodes/EP01/videos/EP01_sh_..._GROK_asset_....mp4",
      "checksum":"sha256:9f2c...", "sizeBytes":3082866, "actualDurationSec":10.0,
      "reviewStatus":"PENDING" } } } }
```
Cloud xác nhận bằng `MESSAGE_ACK` (job → SUCCEEDED, KHÔNG generation thứ hai):
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0D6", "type":"MESSAGE_ACK",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "sentAt":"2026-07-12T01:05:00.200Z",
  "payload":{ "ackedMessageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0C5", "ackedType":"JOB_RECOVERY_REPORT",
    "status":"ACCEPTED", "serverRevision":129, "errorCode":null,
    "reconcile":{ "jobStatus":"SUCCEEDED", "createdSecondGeneration":false } } }
```

### 7.10 Cancellation
Cloud → Worker:
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0E7", "type":"JOB_CANCEL_REQUEST",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "correlationId":"corr_01JQ7ZK9M3N4P5Q6R7S8T9V0E6",
  "sentAt":"2026-07-12T01:02:30.000Z",
  "payload":{ "requestedByUserId":"usr_01JQ7ZK9M3N4P5Q6R7S8T9V0A2", "reason":"USER_CANCELED" } }
```
Worker → Cloud (cloud ack bằng `MESSAGE_ACK`, không lặp lại ở đây):
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0F8", "type":"JOB_CANCELED",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "jobId":"job_01JQ7ZK9M3N4P5Q6R7S8T9V0D5", "correlationId":"corr_01JQ7ZK9M3N4P5Q6R7S8T9V0E6",
  "sentAt":"2026-07-12T01:02:31.000Z",
  "payload":{ "canceledAt":"2026-07-12T01:02:31.000Z", "keptPartialFile":false,
    "note":"Đã kill child + đóng browser job. Không có file dở." } }
```

### 7.11 Worker revocation
```json
{ "protocolVersion":1, "messageId":"msg_01JQ7ZK9M3N4P5Q6R7S8T9V0G9", "type":"WORKER_REVOKED",
  "workspaceId":"ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", "workerId":"wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4",
  "sentAt":"2026-07-12T02:00:00.000Z",
  "payload":{ "reason":"USER_UNPAIRED", "effectiveAt":"2026-07-12T02:00:00.000Z",
    "instruction":"Xóa credential local + resumeToken + ngắt kết nối. Media local giữ nguyên." } }
```
> Worker: xóa credential (DPAPI) **và** resumeToken, đóng WSS, job đang chạy → `INTERRUPTED` local, giữ journal.

---

## 8. Error codes (bảng)

| Code | Nghĩa | Retriable | Loại |
|---|---|---|---|
| `E_UNKNOWN_TYPE` | Message type lạ | Không | Protocol |
| `E_PAYLOAD_TOO_LARGE` | Payload > giới hạn | Không | Protocol |
| `E_SCHEMA_INVALID` | Payload sai schema | Không | Protocol |
| `E_AUTH_FAILED` | Credential sai/revoked | Không | Auth |
| `E_VERSION_UNSUPPORTED` | protocol major sai | Không | Protocol |
| `E_REPLAY` | messageId/sentAt replay | Không | Security |
| `E_JOB_DUPLICATE` | job trùng idempotencyKey | Không (trả job cũ) | Job |
| `E_KEYFRAME_MISSING` | Chưa có keyframe duyệt | Không | Job input |
| `E_SESSION_EXPIRED` | Provider session hết hạn | Sau khi login | Provider |
| `E_PROFILE_LOCKED` | Profile đang bận job khác | Sau khi job kia xong | Worker |
| `E_PROVIDER_UI_CHANGED` | DOM provider đổi | Không (cần vá) | Provider |
| `E_SUBMIT_FAILED` | Không submit được | Có (user xác nhận) | Provider |
| `E_TIMEOUT` | Quá hạn chờ | Có (user xác nhận) | Provider |
| `E_DOWNLOAD_FAILED` | Tải kết quả lỗi | **Có (KHÔNG phí)** nếu result còn | Media |
| `E_INVALID_MP4` | File không hợp lệ | Có | Media |
| `E_IMPORT_FAILED` | Import lỗi | Có (KHÔNG phí) | Media |
| `E_DISK_FULL` | Hết chỗ | Sau khi dọn | Storage |
| `E_MANUAL_REQUIRED` | Cần thao tác tay | Sau khi hoàn tất tay | Provider |
| `E_WORKER_OFFLINE` | Worker offline | Khi online | Connectivity |
| `E_IDENTITY_MISMATCH` | `workerId`/`workspaceId` message lệch danh tính kết nối | Không (reject + audit + có thể đóng kết nối) | Security |
| `E_DURATION_OPTION_UNAVAILABLE` | `requestedDurationSec` không thuộc `supportedDurationsSec` của profile/model | Không — reject TRƯỚC submit, **KHÔNG tốn quota**; mở Grok tay | Job input |
| `E_RESUME_TOKEN_INVALID` | resumeToken sai/hết hạn/đã dùng/không khớp workerId+workspaceId | Không — resume lại bằng full credential | Security |

> **`DURATION_MISMATCH`** không phải error code (job vẫn `SUCCEEDED`): là **reviewStatus phụ** trên variant đã import khi `actualDurationSec` lệch `requestedDurationSec` — giữ variant, không auto-approve, không auto-regenerate, chờ operator.

---

## 9. Compatibility rules
- Cloud phải hỗ trợ **ít nhất protocol major hiện tại + 1 major trước** để Worker chưa update vẫn chạy.
- Thêm message type / field optional = **minor**, forward-compat (bên nhận bỏ qua field lạ).
- Đổi nghĩa / xóa field / đổi allowlist ràng buộc = **major mới**.
- Worker gửi `workerVersion` + `protocolVersion` trong `HELLO`; cloud quyết định `negotiatedProtocolVersion` hoặc từ chối.
- Migration VPS **không** đổi protocol → Worker không cần re-pair (chỉ đổi endpoint nếu hostname đổi, credential giữ nguyên).

## 10. Security requirements (protocol-level)
- WSS bắt buộc (TLS); reject non-TLS.
- Credential trong header khi handshake; verify trước khi nhận message job.
- **Identity mismatch:** `workspaceId`/`workerId` client gửi **không được tin**. Server **derive** từ credential đã auth; message lệch → **`E_IDENTITY_MISMATCH`**: reject message, ghi `audit_events`, tăng **protocol-violation counter**, **đóng kết nối** sau nhiều lần lệch hoặc ngay nếu nghiêm trọng. **KHÔNG silent override rồi xử lý.**
- Strict schema + allowlist mọi payload; reject field/id/enum lạ.
- `messageId` dedupe + `sentAt` window chống replay.
- Không media qua WSS; preview/backup qua HTTPS presigned có scope + hết hạn.
- Log redaction: không log credential/cookie/token/URL nhạy/absolute path/resumeToken.

## 11. resumeToken — vòng đời & bảo mật

`resumeToken` chỉ để **gắn lại nhanh một session vừa rớt** và replay event chưa ack — **KHÔNG** thay thế Worker credential dài hạn.

- **Giá trị:** chuỗi ngẫu nhiên **opaque** (không mang thông tin), cấp trong `HELLO_ACK`.
- **Hết hạn ngắn:** vài phút (khuyến nghị ~120s, đủ cho reconnect backoff). Có `resumeTokenExpiresAt`.
- **Bound chặt:** gắn cứng `workerId` + `workspaceId` + **kết nối/session trước đó** (`sessionId`). Dùng ở worker/workspace/session khác → `E_RESUME_TOKEN_INVALID`.
- **Lưu server-side:** chỉ lưu **hash** (hoặc token **ký** để verify không cần lưu); không lưu plaintext.
- **Không phải credential:** khi resume, Worker vẫn phải mở WSS bằng **full Worker credential** trong header; resumeToken chỉ là tham số để cloud nối lại session cũ + biết gửi lại gì. Không có credential hợp lệ thì resumeToken vô dụng.
- **Rotation:** mỗi lần resume thành công → cấp resumeToken **mới**, vô hiệu cái cũ.
- **Một lần dùng + hết hạn:** dùng xong (hoặc quá hạn) → invalidate ngay.
- **Replay detection:** resumeToken đã dùng mà xuất hiện lại → `E_RESUME_TOKEN_INVALID` + audit.
- **Sau khi credential bị revoke:** mọi resumeToken của Worker đó **vô hiệu ngay** (revoke credential = revoke resume).
- **Sau cloud restart:** resumeToken (hash) lưu ở store bền (DB/redis) nên vẫn verify được; nếu store mất → Worker fallback: reconnect bằng full credential + `STATE_RECONCILE` đầy đủ (không phụ thuộc resumeToken).
- **Worker KHÔNG lưu resumeToken như credential vĩnh viễn** — chỉ giữ trong bộ nhớ phiên; mất kết nối lâu thì bỏ, resume bằng credential + reconcile.
