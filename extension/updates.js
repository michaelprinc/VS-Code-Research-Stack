"use strict";

/**
 * Update channel for the published extension (0.3.10).
 *
 * WHY THIS MODULE EXISTS
 * VS Code updates an extension installed from the Marketplace by itself (`extensions.autoUpdate`, on by
 * default). It does **not** update an extension installed from a local `.vsix`: VS Code marks such an
 * install as pinned and leaves it at the version the operator put there. The toolkit has been distributed
 * as a `.vsix` for every release since 0.3.0, so the people who need an update notice the most are exactly
 * the people VS Code stays silent for. This module asks one question — is a newer version published? — and
 * answers it in the control panel instead of leaving the operator to compare version numbers by hand.
 *
 * WHAT LEAVES THE MACHINE
 * Exactly one request: `GET https://marketplace.visualstudio.com/_apis/public/gallery/vscode/<publisher>/
 * <name>/latest`. The URL contains the publisher id and the extension name, both already public in the
 * manifest. No workspace path, no file name, no user identity, no diagnostics. The response is read as
 * text and only `version`, `engine` and the extension identifier are kept. The request is made at most
 * once per extension-host session, at most once per `CHECK_COOLDOWN_MS` (24 h), and never when
 * `researchStack.checkForUpdates` is false.
 *
 * WHY THE NETWORK CALL IS HERE AND NOWHERE ELSE
 * `scripts/verify_vsix.py` refuses any packaged JavaScript that opens a socket, and this module is the one
 * reviewed exception named in that gate. `transport` is a parameter so every test in `test/updates.test.js`
 * drives the decision logic with a recorded response and no socket at all; the real transport is the only
 * code path that touches `node:https`.
 */

const https = require("node:https");

const MARKETPLACE_HOST = "marketplace.visualstudio.com";
// The engine range of a published build arrives as this property on the version record; it is the same
// property vsce writes into the VSIX manifest.
const MARKETPLACE_ENGINE_PROPERTY = "Microsoft.VisualStudio.Code.Engine";
const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

/** Strict `major.minor.patch`. The Marketplace accepts only this shape, so nothing else is parsed. */
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text || "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** -1 when `a` is older than `b`, 0 when equal, 1 when newer. Null is treated as unknown, not as zero. */
function compareVersions(a, b) {
  const left = typeof a === "string" ? parseVersion(a) : a;
  const right = typeof b === "string" ? parseVersion(b) : b;
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return 0;
}

/**
 * Does an installed VS Code satisfy the published engine range?
 * Only `^x.y.z` and `>=x.y.z` are supported, which is all vsce accepts
 * (`^\*$|^(\^|>=)?((\d+)|x)\.((\d+)|x)\.((\d+)|x)(\-.*)?$` in `@vscode/vsce` `out/validation.js`).
 * A bare version means exactly that version. A range with `x` in it is refused rather than guessed at.
 */
function engineSatisfies(range, version) {
  const match = /^(\^|>=)?(\d+)\.(\d+)\.(\d+)$/.exec(String(range || "").trim());
  if (!match) return null;
  const wanted = parseVersion(version);
  if (!wanted) return null;
  const minimum = { major: Number(match[2]), minor: Number(match[3]), patch: Number(match[4]) };
  if (match[1] === undefined) return compareVersions(wanted, minimum) === 0;
  return compareVersions(wanted, minimum) >= 0;
}

function latestUri(publisher, name) {
  if (!ID_PATTERN.test(publisher) || !ID_PATTERN.test(name)) {
    throw new TypeError("The publisher and extension name must be Marketplace identifiers.");
  }
  return `https://${MARKETPLACE_HOST}/_apis/public/gallery/vscode/${publisher}/${name}/latest`;
}

/**
 * The reviewed network boundary. `fetchImpl` is injected by every test; the default is this module's own
 * HTTPS GET with a redirect hop, a byte cap and a hard timeout.
 */
function httpsGet(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const attempt = (target, hops) => {
      const request = https.get(target, {
        headers: { Accept: "application/json", "User-Agent": "research-stack-toolkit-update-check" },
        timeout: timeoutMs,
      }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location && hops > 0) {
          response.resume();
          try { attempt(new URL(response.headers.location, target).toString(), hops - 1); }
          catch { finish({ status: 0, body: "", error: "redirect could not be resolved" }); }
          return;
        }
        let body = "";
        let bytes = 0;
        let truncated = false;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (truncated) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) { truncated = true; body += chunk.slice(0, chunk.length - (bytes - MAX_RESPONSE_BYTES)); response.destroy(); return; }
          body += chunk;
        });
        response.on("end", () => finish({ status, body, truncated }));
        response.on("error", (error) => finish({ status: 0, body: "", error: error.message }));
      });
      request.on("timeout", () => { request.destroy(); finish({ status: 0, body: "", error: `timed out after ${timeoutMs} ms` }); });
      request.on("error", (error) => finish({ status: 0, body: "", error: error.message }));
    };
    attempt(url, 2);
  });
}

/**
 * Ask the Marketplace what the latest published version is.
 * Returns a verdict object; it never throws, because a failed update check must never look like a
 * failure of the toolkit itself.
 */
async function checkPublishedVersion({ publisher, name, fetchImpl = httpsGet, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let url;
  try { url = latestUri(publisher, name); }
  catch (error) { return { state: "invalid-identity", detail: error.message, url: null }; }

  let response;
  try { response = await fetchImpl(url, { timeoutMs }); }
  catch (error) { return { state: "check-failed", detail: String(error && error.message ? error.message : error), url }; }

  if (!response || typeof response !== "object") return { state: "check-failed", detail: "no response", url };
  if (response.error) return { state: "check-failed", detail: response.error, url };
  if (response.status === 404) {
    return { state: "not-published", detail: "The Marketplace has no published version of this extension.", url };
  }
  if (response.status !== 200) {
    return { state: "check-failed", detail: `the Marketplace answered ${response.status}`, url };
  }

  let parsed;
  try { parsed = JSON.parse(response.body); }
  catch { return { state: "invalid-response", detail: "the Marketplace reply was not JSON", url }; }

  const extension = parsed && (parsed.extension || (Array.isArray(parsed.value) ? parsed.value[0] : parsed.value) || parsed);
  const version = extension && Array.isArray(extension.versions) && extension.versions[0] && extension.versions[0].version;
  if (!version) return { state: "invalid-response", detail: "the Marketplace reply named no version", url };
  const properties = extension.versions[0].properties || [];
  const engineEntry = properties.find((entry) => entry && entry.name === MARKETPLACE_ENGINE_PROPERTY);
  return {
    state: "ok",
    version: String(version),
    engine: engineEntry ? String(engineEntry.value) : null,
    lastUpdated: extension.versions[0].lastUpdated || null,
    truncated: Boolean(response.truncated),
    url,
  };
}

/**
 * Turn "what is installed" and "what is published" into one decision the panel can show.
 * `vscodeVersion` is the editor the operator is actually running; `publishedEngine` is the engine range of
 * the published build. Both matter: a newer build that the operator's VS Code cannot host is not an update
 * they can take.
 */
function updatePlan({ installedVersion, publishedVersion, publishedEngine, vscodeVersion, checkState } = {}) {
  if (checkState && checkState !== "ok") {
    return { state: checkState, installedVersion: installedVersion || null, publishedVersion: null, action: checkState === "not-published" ? "install-from-marketplace" : "retry" };
  }
  const installed = parseVersion(installedVersion);
  const published = parseVersion(publishedVersion);
  if (!installed || !published) {
    return { state: "invalid-response", installedVersion: installedVersion || null, publishedVersion: publishedVersion || null, action: "retry" };
  }
  const order = compareVersions(installed, published);
  if (order > 0) {
    return { state: "ahead-of-channel", installedVersion: String(installedVersion), publishedVersion: String(publishedVersion), action: "none" };
  }
  if (order === 0) {
    return { state: "up-to-date", installedVersion: String(installedVersion), publishedVersion: String(publishedVersion), action: "none" };
  }
  const engine = publishedEngine || null;
  if (engine && vscodeVersion) {
    const satisfied = engineSatisfies(engine, vscodeVersion);
    if (satisfied === false) {
      return {
        state: "editor-too-old",
        installedVersion: String(installedVersion),
        publishedVersion: String(publishedVersion),
        requiredEngine: engine,
        action: "update-vscode",
      };
    }
  }
  return { state: "update-available", installedVersion: String(installedVersion), publishedVersion: String(publishedVersion), requiredEngine: engine, action: "update" };
}

/**
 * Should a check run now? One per session, and not more than once per cooldown window.
 * `lastCheckedAt` is a millisecond timestamp read from the extension's own stored state.
 */
function shouldCheck({ enabled, lastCheckedAt, now = Date.now(), cooldownMs = CHECK_COOLDOWN_MS, force = false } = {}) {
  if (!enabled) return false;
  if (force) return true;
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true;
  return now - lastCheckedAt >= cooldownMs;
}

/** The Marketplace page a human can open, and the identifier VS Code installs from. */
function marketplacePage(publisher, name) {
  return `https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}`;
}

module.exports = {
  MARKETPLACE_HOST,
  CHECK_COOLDOWN_MS,
  REQUEST_TIMEOUT_MS,
  parseVersion,
  compareVersions,
  engineSatisfies,
  latestUri,
  httpsGet,
  checkPublishedVersion,
  updatePlan,
  shouldCheck,
  marketplacePage,
};
