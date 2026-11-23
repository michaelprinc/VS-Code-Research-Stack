#!/usr/bin/env node
"use strict";

/*
 * scripts/panel_renderer_check.js
 *
 * WHAT THIS IS — AND WHAT IT IS NOT.
 *   A Node `node:vm` sandbox plus a hand-written DOM shim that runs the SHIPPED
 *   `extension/media/controls.js` byte-for-byte against the SHIPPED panel document
 *   built by `extension/ui.js`, fed with a SHIPPED `type:"state"` message produced
 *   by the real controller through `extension/test/harness.js`.
 *
 *   This is a DOM shim, NOT a browser. There is no CSS, no layout, no paint, no
 *   focus model, no live-region announcement, no CSP, no nonce handling, no real
 *   event loop, and no real click semantics: in a browser a disabled control
 *   simply does not fire `click`, whereas here the shim decides which clicks it
 *   dispatches. The shim implements only the DOM surface `controls.js` actually
 *   touches (measured from the shipped file), nothing more.
 *
 *   `extension/test/browser.test.js` remains the real-browser test (Playwright +
 *   Chromium). Playwright is not installed in this container and that file has
 *   never executed here, so the panel-side behaviours it asserts had no executed
 *   proof. This script supplies one at the DOM-API level, durably, with no
 *   dependency beyond Node builtins.
 *
 * WHAT IT PROVES:  what the shipped renderer really writes into a real document —
 *   dataset / aria-disabled / title on the Zotero card's buttons, the
 *   pending-request id guard, host-initiated results with no id, the fallback
 *   sentence instead of the word "undefined", and the bounded pending-request set.
 *   Every verdict below carries the measured value taken from the live DOM tree.
 *
 * WHAT IT DOES NOT PROVE:  that a browser paints `title` as a tooltip, that
 *   controls.css renders the unavailable state, that a screen reader announces
 *   `aria-disabled`, that a keyboard user can still reach a disabled control, or
 *   that a disabled control really cannot be pressed. Those need a real browser.
 *
 * A `NOT PROVEN` verdict is an honest outcome for an assertion this harness
 * cannot drive. A PASS without a measured value is not offered.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const CONTROLS_PATH = path.join(ROOT, "extension", "media", "controls.js");

/* ------------------------------------------------------------------ *
 * 1. A minimal DOM: elements, attributes, text, dataset, classList,
 *    listeners, and the selector surface controls.js uses.
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);

function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

class TextNode {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
}

class Element {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = new Map();
    this._value = undefined;
    this._checked = undefined;
    this._dataset = undefined;
  }

  /* -- attributes -------------------------------------------------- */
  setAttribute(name, value) { this.attributes.set(String(name).toLowerCase(), String(value)); }
  getAttribute(name) { const key = String(name).toLowerCase(); return this.attributes.has(key) ? this.attributes.get(key) : null; }
  removeAttribute(name) { this.attributes.delete(String(name).toLowerCase()); }
  hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }

  /* -- tree -------------------------------------------------------- */
  _adopt(node) {
    const child = typeof node === "string" ? new TextNode(node) : node;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...nodes) { for (const node of nodes) this._adopt(node); }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) { this.childNodes.splice(at, 1); child.parentNode = null; }
    return child;
  }

  /* -- events ------------------------------------------------------ */
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  }
  dispatchEvent(event) {
    const filled = Object.assign({ target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, event);
    for (const handler of [...(this._listeners.get(filled.type) || [])]) handler.call(this, filled);
    return true;
  }
  get listenerCount() { let total = 0; for (const list of this._listeners.values()) total += list.length; return total; }

  /* -- selectors --------------------------------------------------- */
  querySelector(selector) { const found = collect(this, selector); return found.length ? found[0] : null; }
  querySelectorAll(selector) { return collect(this, selector); }
}

/* Attribute-reflecting properties, in the shape controls.js uses them. */
function reflect(name, attribute, fallback) {
  Object.defineProperty(Element.prototype, name, {
    configurable: true,
    get() { const value = this.getAttribute(attribute); return value === null ? fallback : value; },
    set(value) { this.setAttribute(attribute, value); },
  });
}
reflect("id", "id", "");
reflect("className", "class", "");
reflect("title", "title", "");
reflect("placeholder", "placeholder", "");

Object.defineProperty(Element.prototype, "type", {
  configurable: true,
  get() { const value = this.getAttribute("type"); return value === null ? (this.tagName === "INPUT" ? "text" : "") : value; },
  set(value) { this.setAttribute("type", value); },
});

Object.defineProperty(Element.prototype, "disabled", {
  configurable: true,
  get() { return this.hasAttribute("disabled"); },
  set(value) { if (value) this.setAttribute("disabled", "true"); else this.removeAttribute("disabled"); },
});

Object.defineProperty(Element.prototype, "value", {
  configurable: true,
  get() {
    if (this._value !== undefined) return this._value;
    const attribute = this.getAttribute("value");
    if (attribute !== null) return attribute;
    return this.tagName === "INPUT" || this.tagName === "SELECT" || this.tagName === "TEXTAREA" ? "" : undefined;
  },
  set(value) { this._value = String(value); },
});

Object.defineProperty(Element.prototype, "checked", {
  configurable: true,
  get() { return this._checked === undefined ? this.hasAttribute("checked") : this._checked; },
  set(value) { this._checked = Boolean(value); if (!this._checked) this.removeAttribute("checked"); },
});

Object.defineProperty(Element.prototype, "textContent", {
  configurable: true,
  get() {
    let out = "";
    const walk = (node) => { for (const child of node.childNodes) { if (child.nodeType === 3) out += child.data; else if (child.nodeType === 1) walk(child); } };
    walk(this);
    return out;
  },
  set(value) { this.replaceChildren(new TextNode(value === undefined ? "undefined" : String(value))); },
});

/* `dataset` is a live view over `data-*` attributes, as in a browser:
   controls.js writes it, deletes from it, and reads it back. */
Object.defineProperty(Element.prototype, "dataset", {
  configurable: true,
  get() {
    if (!this._dataset) {
      const element = this;
      const dash = (key) => "data-" + String(key).replace(/([A-Z])/g, "-$1").toLowerCase();
      this._dataset = new Proxy({}, {
        get: (_t, key) => (typeof key === "string" ? element.getAttribute(dash(key)) ?? undefined : undefined),
        set: (_t, key, value) => { element.setAttribute(dash(key), value); return true; },
        deleteProperty: (_t, key) => { element.removeAttribute(dash(key)); return true; },
        has: (_t, key) => element.hasAttribute(dash(key)),
        ownKeys: () => [...element.attributes.keys()].filter((key) => key.startsWith("data-")).map((key) => key.slice(5)),
        getOwnPropertyDescriptor: (_t, key) => (element.hasAttribute(dash(key)) ? { value: element.getAttribute(dash(key)), enumerable: true, configurable: true } : undefined),
      });
    }
    return this._dataset;
  },
});

Object.defineProperty(Element.prototype, "classList", {
  configurable: true,
  get() {
    const element = this;
    const read = () => (element.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    const write = (list) => element.setAttribute("class", list.join(" "));
    return {
      add: (...names) => { const list = read(); for (const name of names) if (!list.includes(name)) list.push(name); write(list); },
      remove: (...names) => { write(read().filter((item) => !names.includes(item))); },
      contains: (name) => read().includes(name),
      toggle: (name, force) => {
        const list = read();
        const has = list.includes(name);
        const want = force === undefined ? !has : Boolean(force);
        if (want && !has) list.push(name);
        if (!want && has) list.splice(list.indexOf(name), 1);
        write(list);
        return want;
      },
      get length() { return read().length; },
    };
  },
});

/* -- the selector surface controls.js uses: selector lists, tag names,
      #id, .class, [attr], [attr=value], :checked, and descendant combinators.
      Nothing else is supported, and controls.js asks for nothing else. ---- */

function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const ch of text) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === separator && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseCompound(text) {
  const conditions = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "#") { let name = ""; i++; while (i < text.length && !"#.[:".includes(text[i])) name += text[i++]; conditions.push({ kind: "id", name }); continue; }
    if (ch === ".") { let name = ""; i++; while (i < text.length && !"#.[:".includes(text[i])) name += text[i++]; conditions.push({ kind: "class", name }); continue; }
    if (ch === ":") { let name = ""; i++; while (i < text.length && !"#.[:[".includes(text[i])) name += text[i++]; conditions.push({ kind: "pseudo", name }); continue; }
    if (ch === "[") {
      i++;
      let body = ""; let quote = null;
      while (i < text.length) {
        const c = text[i];
        if (quote) { body += c; if (c === quote) quote = null; i++; continue; }
        if (c === '"' || c === "'") { quote = c; body += c; i++; continue; }
        if (c === "]") { i++; break; }
        body += c; i++;
      }
      const eq = splitTop(body, "=");
      conditions.push({ kind: "attr", name: eq[0].trim(), value: eq.length > 1 ? eq.slice(1).join("=").trim().replace(/^["']|["']$/g, "") : undefined });
      continue;
    }
    let name = "";
    while (i < text.length && !"#.[:".includes(text[i])) name += text[i++];
    conditions.push({ kind: "tag", name });
  }
  return conditions;
}

function parseSelector(selector) {
  return splitTop(selector, ",").map((part) => part.trim()).filter(Boolean)
    .map((part) => part.split(/\s+/).filter(Boolean).map(parseCompound));
}

function matchesCompound(element, conditions) {
  for (const condition of conditions) {
    if (condition.kind === "tag") { if (condition.name !== "*" && element.tagName !== condition.name.toUpperCase()) return false; continue; }
    if (condition.kind === "id") { if (element.getAttribute("id") !== condition.name) return false; continue; }
    if (condition.kind === "class") { if (!element.classList.contains(condition.name)) return false; continue; }
    if (condition.kind === "attr") {
      const value = element.getAttribute(condition.name);
      if (value === null) return false;
      if (condition.value !== undefined && value !== condition.value) return false;
      continue;
    }
    if (condition.kind === "pseudo") {
      if (condition.name === "checked" && element.checked !== true) return false;
      if (condition.name === "disabled" && element.disabled !== true) return false;
      return false; // any other pseudo-class is unsupported, and controls.js never asks for one
    }
  }
  return true;
}

function matchesChain(element, chain) {
  let index = chain.length - 1;
  if (!matchesCompound(element, chain[index])) return false;
  index--;
  let node = element.parentNode;
  while (index >= 0 && node) {
    if (node.nodeType === 1 && matchesCompound(node, chain[index])) index--;
    node = node.parentNode;
  }
  return index < 0;
}

function collect(root, selector) {
  const chains = parseSelector(selector);
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (chains.some((chain) => matchesChain(child, chain))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/* -- a tiny HTML parser: enough for the document ui.js emits (well-formed,
      void elements, quoted and unquoted attributes, entities, raw script text). ---- */

function parseTag(html, start) {
  let i = start + 1;
  let name = "";
  while (i < html.length && !/[\s/>]/.test(html[i])) name += html[i++];
  const attributes = [];
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) break;
    if (html[i] === ">") return { name, attributes, selfClosing: false, end: i + 1 };
    if (html[i] === "/" && html[i + 1] === ">") return { name, attributes, selfClosing: true, end: i + 2 };
    let attrName = "";
    const beforeAttr = i;
    while (i < html.length && !/[\s=/>]/.test(html[i])) attrName += html[i++];
    let attrValue = null;
    let probe = i;
    while (probe < html.length && /\s/.test(html[probe])) probe++;
    if (html[probe] === "=") {
      i = probe + 1;
      while (i < html.length && /\s/.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        i++;
        let value = "";
        while (i < html.length && html[i] !== quote) value += html[i++];
        i++;
        attrValue = decodeEntities(value);
      } else {
        let value = "";
        while (i < html.length && !/[\s>]/.test(html[i])) value += html[i++];
        attrValue = decodeEntities(value);
      }
    }
    if (attrName) attributes.push([attrName.toLowerCase(), attrValue === null ? "" : attrValue]);
    else if (i === beforeAttr) i++; // a stray character in a tag position must not spin the parser
  }
  return { name, attributes, selfClosing: true, end: html.length };
}

function parseDocument(html) {
  const documentElement = new Element("html");
  const stack = [documentElement];
  let i = 0;
  let previous = -1;
  while (i < html.length) {
    // A parser bug must fail loudly here, not hang the check.
    if (i === previous) throw new Error(`the HTML parser made no progress at offset ${i}: ${JSON.stringify(html.slice(i, i + 80))}`);
    previous = i;
    const lt = html.indexOf("<", i);
    if (lt < 0) { stack[stack.length - 1].append(new TextNode(decodeEntities(html.slice(i)))); break; }
    if (lt > i) { stack[stack.length - 1].append(new TextNode(decodeEntities(html.slice(i, lt)))); i = lt; }
    if (html.startsWith("<!--", i)) { const end = html.indexOf("-->", i); i = end < 0 ? html.length : end + 3; continue; }
    if (html.startsWith("<!", i)) { const end = html.indexOf(">", i); i = end < 0 ? html.length : end + 1; continue; }
    if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      const name = html.slice(i + 2, end).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tagName.toLowerCase() === name) { stack.length = k; break; }
      }
      i = end + 1;
      continue;
    }
    const tag = parseTag(html, i);
    i = tag.end;
    if (!tag.name) continue;
    const element = new Element(tag.name);
    for (const [name, value] of tag.attributes) element.setAttribute(name, value);
    stack[stack.length - 1].append(element);
    if (RAW_TEXT_TAGS.has(tag.name.toLowerCase())) {
      const close = html.toLowerCase().indexOf("</" + tag.name.toLowerCase(), i);
      i = close < 0 ? html.length : close;
      continue;
    }
    if (!tag.selfClosing && !VOID_TAGS.has(tag.name.toLowerCase())) stack.push(element);
  }
  return documentElement;
}

function makeDocument(html) {
  const documentElement = parseDocument(html);
  const document = {
    nodeType: 9,
    documentElement,
    get body() { return documentElement.querySelector("body") || documentElement; },
    get head() { return documentElement.querySelector("head") || documentElement; },
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    getElementById(id) {
      const wanted = String(id);
      const stack = [documentElement];
      while (stack.length) {
        const node = stack.shift();
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (child.getAttribute("id") === wanted) return child;
          stack.push(child);
        }
      }
      return null;
    },
    querySelector: (selector) => collect(documentElement, selector)[0] || null,
    querySelectorAll: (selector) => collect(documentElement, selector),
  };
  return document;
}

/* ------------------------------------------------------------------ *
 * 2. Verdict plumbing
 * ------------------------------------------------------------------ */

const results = [];
const observations = [];
function verdict(id, ok, measured, note) {
  results.push({ id, ok, measured, note });
  console.log(`${ok === null ? "NOT PROVEN" : ok ? "PASS" : "FAIL"}  ${id}  ${measured}${note ? `  — ${note}` : ""}`);
}
function observe(text) { observations.push(text); console.log(`OBSERVE  ${text}`); }

/* ------------------------------------------------------------------ *
 * 3. The real panel document, the shipped renderer, the real state
 * ------------------------------------------------------------------ */

const { controlPanelHtml } = require(path.join(ROOT, "extension", "ui.js"));
const { makeHarness } = require(path.join(ROOT, "extension", "test", "harness.js"));
const { PROBE_BLOCKED_SENTENCE } = require(path.join(ROOT, "extension", "integrations.js"));
const TOOLKIT_VERSION = require(path.join(ROOT, "extension", "package.json")).version;

const controlsSource = fs.readFileSync(CONTROLS_PATH, "utf8");
const controlsDigest = crypto.createHash("sha256").update(controlsSource).digest("hex").slice(0, 16);

const stubUri = { joinPath: (base, ...parts) => [base, ...parts].join("/") };
const stubWebview = { cspSource: "x", asWebviewUri: (u) => String(u) };

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-panel-renderer-check-"));
  try {
    const harness = makeHarness({
      folders: [{ name: "Research Panel Check", uri: { scheme: "file", fsPath: tempRoot } }],
      initial: { selectedPackage: "recommended" },
      diagnosticServices: { async findHostTool() { return undefined; }, async runFile() { return ""; } },
    });
    const panel = harness.api.openControlPanel();

    // The shipped controller's outbound channel, replaced by a recorder so the
    // state the panel would have been sent is the state this check feeds the renderer.
    const posted = [];
    panel.webview.postMessage = async (message) => { posted.push(message); return true; };
    await panel.receive({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 120)); // let the held update check settle into a state

    const states = posted.filter((message) => message && message.type === "state");
    if (!states.length) throw new Error("the shipped harness produced no type:\"state\" message after ready");
    const realState = JSON.parse(JSON.stringify(states.at(-1)));

    const html = controlPanelHtml(stubWebview, "https://toolkit.test/extension", stubUri);
    const document = makeDocument(html);
    const window = {
      _listeners: new Map(),
      addEventListener(type, handler) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(handler); },
      removeEventListener(type, handler) { const list = this._listeners.get(type); if (list) { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1); } },
      dispatchEvent(event) {
        const filled = Object.assign({ preventDefault() {}, stopPropagation() {} }, event);
        for (const handler of [...(this._listeners.get(filled.type) || [])]) handler(filled);
        return true;
      },
    };

    const outbound = [];
    const context = vm.createContext({
      window,
      document,
      acquireVsCodeApi: () => ({ postMessage: (message) => { outbound.push(JSON.parse(JSON.stringify(message))); return true; } }),
      console: { log() {}, warn() {}, error() {} },
    });

    console.log(`panel_renderer_check  controls.js sha256:${controlsDigest} (${controlsSource.length} bytes, run byte-for-byte in node:vm)`);
    console.log(`panel_renderer_check  harness state messages recorded: ${states.length}; version v${realState.version}; integration views: ${(realState.integrations && realState.integrations.views || []).length}`);
    console.log(`panel_renderer_check  document parsed: ${document.querySelectorAll("button, input, select").length} controls, ${document.querySelectorAll("[data-action]").length} data-action buttons, #feedback present: ${Boolean(document.getElementById("feedback"))}`);

    vm.runInContext(controlsSource, context, { filename: "extension/media/controls.js" });

    const dispatchMessage = (data) => window.dispatchEvent({ type: "message", data, source: window });
    const feedback = () => { const element = document.getElementById("feedback"); return element ? element.textContent : "<#feedback missing>"; };
    const click = (element) => {
      if (!element) return false;
      if (element.disabled) return false; // a browser will not fire click on a disabled control; neither does this shim
      element.dispatchEvent({ type: "click" });
      return true;
    };

    const sentIds = () => outbound.filter((message) => message && message.requestId !== undefined).map((message) => message.requestId);

    /* -- drive the real state ---------------------------------------- */
    dispatchMessage(realState);
    const baselineFeedback = feedback();
    observe(`after the real state: #feedback = ${JSON.stringify(baselineFeedback)}; #version = ${JSON.stringify(document.getElementById("version").textContent)}; #workspace = ${JSON.stringify(document.getElementById("workspace").textContent)}`);

    const zoteroCard = () => {
      const list = document.getElementById("integration-list");
      const cards = list.querySelectorAll("article");
      return [...cards].find((card) => { const h3 = card.querySelector("h3"); return h3 && h3.textContent === "Zotero"; }) || null;
    };
    const buttonIn = (card, label) => {
      if (!card) return null;
      return [...card.querySelectorAll("button")].find((button) => button.textContent === label) || null;
    };

    /* -- A and B: the blocked check on the Zotero card ---------------- */
    const untouched = zoteroCard();
    const untouchedCheck = buttonIn(untouched, "Check now");
    const zoteroBefore = realState.integrations.views.find((view) => view.id === "zotero");
    observe(`before the mutation the harness's own zotero view reports probeBlocked=${JSON.stringify(zoteroBefore.probeBlocked)} probeWaitMs=${zoteroBefore.probeWaitMs}, and the rendered "Check now" button carries data-unavailable=${JSON.stringify(untouchedCheck && untouchedCheck.getAttribute("data-unavailable"))} aria-disabled=${JSON.stringify(untouchedCheck && untouchedCheck.getAttribute("aria-disabled"))} title=${JSON.stringify(untouchedCheck && untouchedCheck.getAttribute("title"))} — so A below measures the effect of the mutation, not of the untouched state.`);

    const mutated = JSON.parse(JSON.stringify(realState));
    const zoteroView = mutated.integrations.views.find((view) => view.id === "zotero");
    zoteroView.probeBlocked = PROBE_BLOCKED_SENTENCE;
    zoteroView.probeWaitMs = 12000;
    dispatchMessage(mutated);
    const afterMutated = feedback();

    const card = zoteroCard();
    const checkButton = buttonIn(card, "Check now");
    const activateButton = buttonIn(card, "Activate");
    const labels = card ? [...card.querySelectorAll("button")].map((button) => button.textContent) : [];

    if (!card || !checkButton) {
      verdict("A", null, "no Zotero card / no \"Check now\" button in the rendered #integration-list", "the shipped state did not offer this action here");
    } else {
      const unavailable = checkButton.getAttribute("data-unavailable");
      const aria = checkButton.getAttribute("aria-disabled");
      const title = checkButton.getAttribute("title");
      const okA = unavailable === "true" && aria === "true" && typeof title === "string" && title.includes(PROBE_BLOCKED_SENTENCE) && title.includes("12 s");
      verdict("A", okA, `data-unavailable=${JSON.stringify(unavailable)} aria-disabled=${JSON.stringify(aria)} title=${JSON.stringify(title)}`,
        "the reason text and the whole-seconds wait are both on the button the operator would press");
    }

    if (!activateButton) {
      verdict("B", null, "no \"Activate\" button on the Zotero card", `the card offered ${JSON.stringify(labels)}`);
    } else {
      const unavailable = activateButton.getAttribute("data-unavailable");
      const aria = activateButton.getAttribute("aria-disabled");
      verdict("B", unavailable === null && aria === null,
        `data-unavailable=${JSON.stringify(unavailable)} aria-disabled=${JSON.stringify(aria)} title=${JSON.stringify(activateButton.getAttribute("title"))}`,
        "only the actions that start a check are marked unavailable");
    }

    /* -- C: an orphan result must not be painted ---------------------- */
    const clickable = document.querySelector('[data-action="integrations"]');
    const clicked = click(clickable);
    const beforeC = feedback();
    if (!clicked) {
      verdict("C", null, `the shipped panel left no enabled button to press (disabled=${clickable ? clickable.disabled : "no such button"})`, "could not reach the send path");
    } else {
      dispatchMessage({ type: "result", requestId: 987654, message: "A late answer to a request this panel never made." });
      const afterC = feedback();
      verdict("C", afterC === beforeC && !afterC.includes("A late answer"),
        `#feedback before=${JSON.stringify(beforeC)} after=${JSON.stringify(afterC)} (requestId 987654 was never sent; ids sent so far: ${sentIds().length})`,
        "the orphan result is dropped instead of replacing the panel's own status line");
    }

    /* -- D: a result with no id is the host speaking ------------------ */
    dispatchMessage({ type: "result", message: "Host-initiated status line." });
    const afterD = feedback();
    verdict("D", afterD === "Host-initiated status line.", `#feedback = ${JSON.stringify(afterD)}`, "shown verbatim, and it touched no pending request");

    /* -- E: the word "undefined" is never painted --------------------- */
    const undefinedHits = [];
    const checkUndefined = (label) => { const text = feedback(); if (text.includes("undefined")) undefinedHits.push(`${label}: ${JSON.stringify(text)}`); };
    checkUndefined("after the real state");
    checkUndefined("after the mutated state");
    checkUndefined("after the orphan result");
    checkUndefined("after the host result with no id");
    // The hardest case the shipped comment names: a result carrying neither an error nor a message.
    dispatchMessage({ type: "result" });
    const noFieldFeedback = feedback();
    checkUndefined("after a result with neither error nor message");
    verdict("E", undefinedHits.length === 0,
      `#feedback after the states driven: ${JSON.stringify([baselineFeedback, afterMutated])}; after a bare result: ${JSON.stringify(noFieldFeedback)}`,
      undefinedHits.length ? `found the word in: ${undefinedHits.join("; ")}` : "no state and no bare result painted the word \"undefined\"");

    /* -- F: the pending-request set is bounded ------------------------ */
    const SENDS = 1000;
    const enabledBefore = click(clickable);
    if (!enabledBefore) {
      verdict("F", null, "the shipped panel exposes no control that stays clickable after a send", "the bound could not be driven honestly");
    } else {
      const firstSendIndex = outbound.length;
      let clicks = 0;
      for (let n = 0; n < SENDS; n++) {
        const button = document.querySelector('[data-action="integrations"]');
        if (button && !button.disabled && click(button)) clicks++;
      }
      const ids = outbound.slice(firstSendIndex).map((message) => message.requestId);
      const oldest = ids[0];
      const newest = ids[ids.length - 1];
      // Probe every id this panel actually sent. An id still in the pending set is
      // answered (#feedback becomes the result's own text); an evicted id is dropped
      // and #feedback keeps the previous answer.
      const applied = [];
      const dropped = [];
      for (const id of ids) {
        const marker = `RESULT-${id}`;
        dispatchMessage({ type: "result", requestId: id, message: marker });
        if (feedback() === marker) applied.push(id); else dropped.push(id);
      }
      const newestApplied = applied.includes(newest);
      const oldestEvicted = !applied.includes(oldest);
      const bounded = applied.length > 0 && applied.length <= 25 && dropped.length > 0;
      verdict("F", newestApplied && oldestEvicted && bounded && clicks === SENDS,
        `${clicks} sends through the shipped send() path (ids ${oldest}..${newest}); answered=${applied.length} ids ${applied[0]}..${applied[applied.length - 1]}; evicted=${dropped.length} ids ${dropped[0]}..${dropped[dropped.length - 1]}`,
        `newest id ${newest} answered=${newestApplied}; oldest id ${oldest} evicted=${oldestEvicted}; measured bound=${applied.length} (the shipped PENDING_REQUEST_LIMIT is 25)`);
    }

    /* -- G: `data-readonly` must not swallow an explicit unavailability - *
     * Found by this check on its first run: applyControlAvailability() returned on the
     * isReadOnly branch before the unavailable branch, so [data-action="updateNow"] carried
     * data-unavailable="true" and an explanatory title while staying enabled and unannounced.
     * The invariant A and B rely on — unavailable ⇒ disabled + aria-disabled — must hold for a
     * read-only control too. `data-readonly` means the busy flag must not disable it, nothing more.
     */
    const updateNow = document.querySelector('[data-action="updateNow"]');
    if (!updateNow) {
      verdict("G", null, "no [data-action=\"updateNow\"] in the document", "NOT PROVEN — the control this row measures is not in the shipped document");
    } else {
      const marked = updateNow.getAttribute("data-unavailable") === "true";
      const readonly = updateNow.getAttribute("data-readonly") === "true";
      const disabledNow = updateNow.disabled === true;
      const announced = updateNow.getAttribute("aria-disabled") === "true";
      const reason = String(updateNow.getAttribute("title") || "");
      verdict("G", marked && readonly && disabledNow && announced && reason.length > 0,
        `data-readonly=${JSON.stringify(updateNow.getAttribute("data-readonly"))} data-unavailable=${JSON.stringify(updateNow.getAttribute("data-unavailable"))} disabled=${updateNow.disabled} aria-disabled=${JSON.stringify(updateNow.getAttribute("aria-disabled"))} title=${JSON.stringify(reason)}`,
        "a read-only control the renderer marks unavailable is disabled, announced, and still explains itself");
    }

    /* -- H: the 0.3.14 bundle-archive and preset-tool-selection controls are in the shipped document ---
     * `extension.js` registers the commands and its action map names them, but a command nobody can reach
     * from the panel is a command the operator does not have. This row measures what the shipped document
     * really contains, including the wording: the force button does not promise an overwrite, the preset
     * button says "select", not "install". What it does NOT prove: that the command then shows its modal,
     * archives before it replaces, or refuses a file it did not write — those are proven in
     * extension/test/bundles.test.js and extension/test/presetselect.test.js against the controller.
     */
    const newControls = [
      ["forceBundleUpdate", "Force-update topic bundle where a file differs"],
      ["bundleArchives", "Show bundle archive history"],
      ["restoreBundleArchive", "Restore an archived bundle version"],
      ["configurePresetTools", "Select the GitHub tools this preset offers Copilot"],
    ];
    const measuredH = newControls.map(([action, expected]) => {
      const button = document.querySelector(`[data-action="${action}"]`);
      return { action, label: button ? button.textContent : "<no such control>", expected };
    });
    const okH = measuredH.every((item) => item.label === item.expected);
    verdict("H", okH, measuredH.map((item) => `[data-action="${item.action}"]=${JSON.stringify(item.label)}`).join(" "),
      "all four 0.3.14 controls are in the panel document the shipped controller builds, each with the label the release states; the modal, the archive-before-overwrite and the refusal live in the commands, not in this row");

    /* -- I: a retired preset in force is explained, not left as a blank section (DD15-07) -------------
     * The state fed here is a real one: a second harness at package `full` with `research-lab-max` saved,
     * read straight out of the shipped controller. The retired preset has no card in `state.presets` by
     * design, so the question is what the renderer paints when the preset in force has no card — silence
     * would read as a broken panel. This measures the two lines the renderer writes for that state.
     */
    const retiredHarness = makeHarness({
      folders: [{ name: "Research Panel Check", uri: { scheme: "file", fsPath: tempRoot } }],
      initial: { selectedPackage: "full", toolsPreset: "research-lab-max" },
      diagnosticServices: { async findHostTool() { return undefined; }, async runFile() { return ""; } },
    });
    const retiredState = JSON.parse(JSON.stringify(retiredHarness.api.state()));
    if (retiredState.selectedToolsPreset !== "research-lab-max" || typeof retiredState.presetRetirement !== "string" || retiredState.presets.some((preset) => preset.retired)) {
      verdict("I", null, `the shipped controller gave selectedToolsPreset=${JSON.stringify(retiredState.selectedToolsPreset)} presetRetirement=${JSON.stringify(retiredState.presetRetirement)} offeredRetired=${retiredState.presets.filter((preset) => preset.retired).length}`,
        "NOT PROVEN — the controller did not produce the retired-preset state this row measures");
    } else {
      dispatchMessage(retiredState);
      const noteText = document.getElementById("preset-note").textContent;
      const savedText = document.getElementById("saved-preset").textContent;
      const cards = document.getElementById("preset-list").querySelectorAll("label").length;
      const okI = noteText.includes("retired in 0.3.14") && noteText.includes("research-max-github-full")
        && savedText.includes("research-lab-max") && !noteText.includes("undefined") && !savedText.includes("undefined")
        && retiredState.presets.length > 0 && cards === retiredState.presets.length;
      verdict("I", okI, `#preset-note=${JSON.stringify(noteText)} #saved-preset=${JSON.stringify(savedText)} preset cards rendered=${cards}/${retiredState.presets.length}`,
        "the retirement and its replacements are painted where the operator is looking, and the offered presets still render; what is NOT claimed here is that the retired preset's own tools are still available — the row above it says 0.3.14 cannot name them");
      dispatchMessage(realState); // leave the document on the state the other rows measured
    }
    const selectValue = document.getElementById("diagnostics-workspace").value;
    observe(`shim fidelity: the renderer assigns select.value = ${JSON.stringify(selectValue)}; this shim stores the assignment and does not select the matching <option> (a browser would set selectedIndex). controls.js only reads select.value back off a change event, so no assertion here depends on it.`);

    /* ------------------------------------------------------------------ *
     * 4. Summary
     * ------------------------------------------------------------------ */
    const failures = results.filter((item) => item.ok === false);
    const unproven = results.filter((item) => item.ok === null);
    console.log("");
    console.log("SUMMARY");
    for (const item of results) {
      const label = item.ok === null ? "NOT PROVEN" : item.ok ? "PASS" : "FAIL";
      console.log(`  ${item.id}  ${label.padEnd(10)} ${item.measured}`);
    }
    console.log("");
    console.log(`  assertions run: ${results.length}   pass: ${results.filter((item) => item.ok === true).length}   fail: ${failures.length}   not proven: ${unproven.length}`);
    console.log("  A real browser is still needed for: the visual and assistive-technology consequences of A and B (does controls.css render the unavailable state, does the title really appear as a tooltip, does a screen reader announce aria-disabled, can a keyboard user still reach the control); for C, D and E, that a live region really speaks the text the shim measured; for F and G, that a disabled control genuinely cannot be pressed and that 1000 presses of a read-only button are reachable by a real operator; for H and I, that these controls and sentences are reachable by keyboard and are what a screen reader reads. The DOM-level behaviour of A to I is proven here; the browser-level behaviour of A to I is proven only by extension/test/browser.test.js, which runs as `npm run test:browser` on a host that has fetched a Chromium build (`npx playwright install chromium`). It has run on this host since 0.3.15 and renders the shipped markup, script and stylesheet in Chromium with no renderer errors and three theme screenshots. What it is not, and cannot be, is a VS Code webview: no editor CSP, no `acquireVsCodeApi` sandbox, no workbench theme variables beyond the ones the case injects, and no assistive technology in the loop. Keyboard reachability and what a screen reader announces remain unproven in this repository.");
    console.log("  Not covered by this shim at all: CSS, layout, overflow, theme variables, screenshots, CSP and the script nonce, real focus and keyboard order, form submit semantics, and any pseudo-class beyond :checked/:disabled.");

    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    console.error(`FAIL  harness  the check could not be driven: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`FAIL  harness  uncaught: ${error && error.stack ? error.stack : error}`); process.exitCode = 1; });
