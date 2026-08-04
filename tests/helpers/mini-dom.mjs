// P0 Step 5C.23 — a tiny, dependency-free DOM shim for deterministic component tests of the native-auth UI
// in Node (no browser). It supports exactly what dom.js + the auth pages use: element creation, text/class/
// attribute/dataset/value/checked, append/replaceChildren/remove, event listeners with bubbling for
// click/submit/input/change, focus/activeElement, and a small querySelector/querySelectorAll (by tag,
// #id, .class, [attr], [attr="v"]). innerHTML is stored as an opaque string (used only for the QR SVG),
// never parsed — so a test can assert on it but cannot query into it. This is NOT a spec-complete DOM; it is
// just enough to exercise render + wiring + accessibility attributes deterministically.

class ClassList {
  constructor(el) { this.el = el; }
  _list() { return String(this.el._attrs.class || "").split(/\s+/).filter(Boolean); }
  _set(list) { this.el._attrs.class = list.join(" "); }
  add(...c) { const l = this._list(); for (const x of c) if (!l.includes(x)) l.push(x); this._set(l); }
  remove(...c) { this._set(this._list().filter((x) => !c.includes(x))); }
  contains(c) { return this._list().includes(c); }
  toggle(c, force) { if (force === undefined) { if (this.contains(c)) this.remove(c); else this.add(c); } else if (force) this.add(c); else this.remove(c); return this.contains(c); }
  get value() { return this.el._attrs.class || ""; }
}

class Node {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag ? String(tag).toUpperCase() : null;
    this.nodeName = this.tagName; this.childNodes = []; this.parentNode = null;
    this._attrs = {}; this._listeners = {}; this.dataset = {}; this._text = null;
    this.value = ""; this.checked = false; this._innerHTML = "";
    this.classList = new ClassList(this);
  }
  // ---- text ----
  get textContent() {
    if (this._text != null) return this._text;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) { this._text = String(v); this.childNodes = []; }
  // ---- className mirrors class attr ----
  get className() { return this._attrs.class || ""; }
  set className(v) { this._attrs.class = String(v); }
  get id() { return this._attrs.id || ""; }
  set id(v) { this._attrs.id = String(v); }
  get htmlFor() { return this._attrs.for || ""; }
  set htmlFor(v) { this._attrs.for = String(v); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); this.childNodes = []; }
  // `disabled` reflects the boolean attribute (like a real form control), so setting it via the attribute
  // path (dom.js `button({disabled:true})`) and via the property both work.
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { if (v) this._attrs.disabled = ""; else delete this._attrs.disabled; }
  // ---- attributes ----
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === "class") { /* mirrored */ } }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); }
  removeAttribute(k) { delete this._attrs[k]; }
  // ---- tree ----
  append(...kids) { for (const k of kids) this._insert(k); }
  appendChild(k) { this._insert(k); return k; }
  prepend(...kids) { const first = this.childNodes.slice(); this.childNodes = []; for (const k of kids) this._insert(k); this.childNodes.push(...first); for (const c of first) c.parentNode = this; }
  _insert(k) { const node = k instanceof Node ? k : this.ownerDocument.createTextNode(String(k)); if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.childNodes.push(node); }
  removeChild(k) { const i = this.childNodes.indexOf(k); if (i >= 0) { this.childNodes.splice(i, 1); k.parentNode = null; } return k; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...kids) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this._text = null; for (const k of kids) this._insert(k); }
  replaceWith(node) { if (this.parentNode) { const i = this.parentNode.childNodes.indexOf(this); if (i >= 0) { this.parentNode.childNodes[i] = node; node.parentNode = this.parentNode; this.parentNode = null; } } }
  get children() { return this.childNodes.filter((c) => c.tagName); }
  get firstChild() { return this.childNodes[0] || null; }
  // ---- events ----
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    let node = this;
    while (node) { ev.currentTarget = node; for (const fn of (node._listeners[ev.type] || []).slice()) { if (ev._stop) break; fn.call(node, ev); } if (ev._stop || !ev.bubbles) break; node = node.parentNode; }
    return !ev._defaultPrevented;
  }
  // ---- focus ----
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent(new Evt("click", { bubbles: true })); }
  // ---- queries ----
  querySelector(sel) { return this._find(sel, true)[0] || null; }
  querySelectorAll(sel) { return this._find(sel, false); }
  closest(sel) { let n = this; while (n) { if (n.tagName && matchSel(n, sel)) return n; n = n.parentNode; } return null; }
  _find(sel, first) {
    const out = [];
    const walk = (node) => { for (const c of node.childNodes) { if (!c.tagName) continue; if (matchSel(c, sel)) { out.push(c); if (first) return true; } if (walk(c)) return true; } return false; };
    walk(this);
    return out;
  }
}

function matchSel(el, sel) {
  // supports "tag", "#id", ".class", "[attr]", "[attr=\"v\"]", and comma lists; simple AND of a single token group
  for (const group of String(sel).split(",").map((s) => s.trim())) {
    if (matchToken(el, group)) return true;
  }
  return false;
}
function matchToken(el, token) {
  const parts = token.match(/(\[[^\]]+\]|[.#]?[\w-]+)/g) || [];
  return parts.every((p) => {
    if (p.startsWith("#")) return el.id === p.slice(1);
    if (p.startsWith(".")) return el.classList.contains(p.slice(1));
    if (p.startsWith("[")) { const m = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(p); if (!m) return false; const v = el.getAttribute(m[1]); return m[2] === undefined ? v !== null : v === m[2]; }
    return el.tagName === p.toUpperCase();
  });
}

class Evt {
  constructor(type, { bubbles = false } = {}) { this.type = type; this.bubbles = bubbles; this._stop = false; this._defaultPrevented = false; this.target = null; this.currentTarget = null; this.button = 0; this.metaKey = false; this.ctrlKey = false; this.shiftKey = false; this.key = null; }
  preventDefault() { this._defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
}

class Doc extends Node {
  constructor() {
    super(null, null); this.ownerDocument = this;
    this.documentElement = this.createElement("html");
    this.body = this.createElement("body");
    this.head = this.createElement("head");
    this.documentElement.append(this.head, this.body); // link the tree so querySelector reaches the body's subtree
    this.append(this.documentElement);
    this.activeElement = this.body; this.cookie = "";
  }
  createElement(tag) { const n = new Node(this, tag); return n; }
  createTextNode(text) { const n = new Node(this, null); n._text = String(text); return n; }
}

export function makeDom() {
  const document = new Doc();
  const listeners = {};
  const history = { entries: [{ url: "/", state: {} }], replaceState(state, _t, url) { this.entries[this.entries.length - 1] = { url: String(url), state }; location._set(String(url)); }, pushState(state, _t, url) { this.entries.push({ url: String(url), state }); location._set(String(url)); } };
  const location = {
    href: "https://studio.example.com/login", origin: "https://studio.example.com", pathname: "/login", search: "", hash: "",
    _set(url) { const u = url.startsWith("http") ? new URL(url) : new URL(url, this.origin); this.href = u.href; this.pathname = u.pathname; this.search = u.search; this.hash = u.hash; },
    assign(url) { this._assigned = url; this._set(url); }, replace(url) { this._replaced = url; this._set(url); }, reload() { this._reloaded = true; }
  };
  const window = {
    document, history, location, addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener: () => {},
    dispatch: (t, ev = {}) => { for (const fn of (listeners[t] || []).slice()) fn(ev); },
    requestAnimationFrame: (fn) => { fn(); return 0; }, setTimeout: (fn) => { return 0; }, clearTimeout: () => {},
    localStorage: makeStorage(), sessionStorage: makeStorage(), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  };
  return { window, document, location, history, Evt, storageWrites: window.localStorage._writes, sessionWrites: window.sessionStorage._writes };
}

function makeStorage() {
  const map = new Map(); const _writes = [];
  return { _writes, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { _writes.push([String(k), String(v)]); map.set(String(k), String(v)); }, removeItem: (k) => map.delete(k), clear: () => map.clear(), key: (i) => [...map.keys()][i] || null, get length() { return map.size; } };
}

// Install a dom onto globalThis for modules that read the ambient document/window/location/history.
export function installDom(dom) {
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.location = dom.window.location;
  globalThis.history = dom.window.history; globalThis.localStorage = dom.window.localStorage; globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame; globalThis.Event = Evt; globalThis.CustomEvent = Evt;
  globalThis.Node = Node;
  return dom;
}
export { Evt, Node };
