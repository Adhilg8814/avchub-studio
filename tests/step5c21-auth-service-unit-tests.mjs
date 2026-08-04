// P0 Step 5C.21B — AuthService provider-free unit tests: dependency-injection validation, MFA policy,
// public-result allowlist, email normalization. No DB, no network.
import { createAuthService } from "../control-plane/src/auth/auth-service.mjs";
import { roleRequiresMfa, AUTH_PUBLIC_RESULT } from "../control-plane/src/auth/auth-config.mjs";
import { normalizeEmail, isPlausibleEmail, canonicalRole } from "../control-plane/src/auth/auth-errors.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const throwsType = (n, fn) => { try { fn(); failed += 1; console.log("FAIL(no throw)", n); } catch (e) { if (e instanceof TypeError) passed += 1; else { failed += 1; console.log("FAIL(type)", n, e.message); } } };

// ---- DI validation ----
const stubFns = Object.fromEntries(["hashPassword", "verifyPassword", "needsRehash", "validatePasswordPolicy", "generateToken", "hashToken", "verifyTotp", "decryptTotpSecret"].map((k) => [k, () => {}]));
const goodRepos = Object.fromEntries(["user", "workspace", "credential", "mfa", "recovery", "session", "preAuth", "reauth", "resetToken", "security"].map((k) => [k, {}]));
throwsType("DI missing persistence", () => createAuthService({ setAuthContext: () => {}, repos: goodRepos, ...stubFns }));
throwsType("DI missing setAuthContext", () => createAuthService({ persistence: { transaction() {} }, repos: goodRepos, ...stubFns }));
throwsType("DI missing a repo", () => createAuthService({ persistence: { transaction() {} }, setAuthContext: () => {}, repos: { ...goodRepos, session: undefined }, ...stubFns }));
throwsType("DI missing a crypto fn", () => createAuthService({ persistence: { transaction() {} }, setAuthContext: () => {}, repos: goodRepos, ...stubFns, verifyTotp: undefined }));
const svc = createAuthService({ persistence: { transaction() {} }, setAuthContext: () => {}, repos: goodRepos, ...stubFns });
check("DI valid deps build a frozen service", svc && typeof svc.beginLogin === "function" && Object.isFrozen(svc));
check("service exposes the full method surface", ["beginLogin", "completeMfaLogin", "resolveSession", "switchWorkspace", "changePassword", "logout", "logoutAll", "logoutOthers", "revokeSession", "listSessions", "listSecurityEvents"].every((m) => typeof svc[m] === "function"));

// ---- MFA policy ----
check("OWNER always requires MFA", roleRequiresMfa("OWNER") === true);
check("ADMIN always requires MFA", roleRequiresMfa("ADMIN") === true);
check("MEMBER optional by default", roleRequiresMfa("MEMBER") === false);
check("MEMBER required under workspace policy", roleRequiresMfa("MEMBER", { workspaceRequiresMfa: true }) === true);
check("VIEWER optional even with ws policy", roleRequiresMfa("VIEWER", { workspaceRequiresMfa: true }) === false);
check("per-user enforce flag forces MFA", roleRequiresMfa("VIEWER", { userMfaEnforced: true }) === true);

// ---- public result allowlist (the only shapes an unauth caller can see) ----
check("public results include generic failure + no internal codes", AUTH_PUBLIC_RESULT.AUTHENTICATION_FAILED === "AUTHENTICATION_FAILED" && !("AUTH_USER_NOT_FOUND" in AUTH_PUBLIC_RESULT) && !("AUTH_PASSWORD_MISMATCH" in AUTH_PUBLIC_RESULT));

// ---- email normalization + role canonicalization ----
check("email NFKC/trim/lowercase", normalizeEmail("  Foo@Example.COM ") === "foo@example.com");
check("email no gmail dot/plus rewrite", normalizeEmail("a.b+tag@x.co") === "a.b+tag@x.co");
check("plausible email accepted", isPlausibleEmail("a@b.co") === true && isPlausibleEmail("nope") === false && isPlausibleEmail("a b@c.co") === false);
check("legacy roles canonicalize", canonicalRole("EDITOR") === "MEMBER" && canonicalRole("REVIEWER") === "VIEWER" && canonicalRole("BILLING_OWNER") === "ADMIN" && canonicalRole("OWNER") === "OWNER" && canonicalRole("bogus") === null);

console.log(`Step 5C.21B auth service unit: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
