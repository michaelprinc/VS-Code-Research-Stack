"use strict";

/**
 * Integration persistence and credentials (0.3.11): the one place the Toolkit writes the integration record (editor
 * profile `globalState`, one key) and the one place it touches an API key (SecretStorage, one name per provider —
 * DD11-04). `globalState` and `secrets` are parameters, not imports, so the whole path runs in a test. No secret
 * enters the record, and a refusal never quotes the value it refused. Nothing found in the environment is deleted
 * (DD11-08), so `environmentFootprint` returns NAMES and cannot return a value.
 */

const integrations = require("./integrations");

const REGISTRY_STATE_KEY = "researchToolkit.integrations";
const API_KEY_MIN = 8;
const API_KEY_MAX = 256;
// The names DD11-08 names. Only names.
const ENVIRONMENT_NAMES = ["SEMANTIC_SCHOLAR_API_KEY", "SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", "OPENALEX_API_KEY", "CROSSREF_MAILTO", "CROSSREF_PLUS_API_TOKEN"];

const secretKey = (provider) => `researchStack.integration/${provider}/apiKey`;
const loadRegistry = (globalState) => integrations.readRegistry(globalState?.get?.(REGISTRY_STATE_KEY)).registry;

async function saveRegistry(globalState, registry) {
  if (typeof globalState?.update !== "function") throw new Error("The Toolkit could not save the integration record: this profile offers no storage.");
  try {
    await globalState.update(REGISTRY_STATE_KEY, registry);
    return registry;
  } catch (error) {
    // The underlying message is not quoted: a storage failure can echo back the value it failed to write.
    throw new Error(`The Toolkit could not save the integration record (${(error && (error.code || error.name)) || "the write was refused"}). Nothing was written.`);
  }
}

/** Printable ASCII 0x21–0x7E only, so a pasted value cannot smuggle a line break or a tab into an argument or a log. */
function validateApiKey(value) {
  if (typeof value !== "string") return { ok: false, reason: "an API key has to be typed as text" };
  if (value !== value.trim()) return { ok: false, reason: "an API key may not start or end with a space or another invisible character" };
  if (value.length < API_KEY_MIN) return { ok: false, reason: `an API key has to be at least ${API_KEY_MIN} characters long` };
  if (value.length > API_KEY_MAX) return { ok: false, reason: `an API key may not be longer than ${API_KEY_MAX} characters` };
  if (!/^[\x21-\x7e]+$/.test(value)) return { ok: false, reason: "an API key may contain only printable characters — no space, tab, line break or accented letter" };
  return { ok: true, reason: null };
}

async function storeApiKey(secrets, provider, value) {
  const check = validateApiKey(value);
  if (!check.ok) throw new Error(`The Toolkit did not store the key: ${check.reason}. Nothing was saved.`);
  await secrets.store(secretKey(provider), value);
  return { configured: true, provider };
}

const readApiKey = async (secrets, provider) => { const value = await secrets.get(secretKey(provider)); return typeof value === "string" ? value : undefined; };
// Answers "is there a key" without handing one back: the panel only needs the boolean (DD11-06).
const hasApiKey = async (secrets, provider) => ((await readApiKey(secrets, provider)) || "").length > 0;
const clearApiKey = (secrets, provider) => secrets.delete(secretKey(provider));

/** `split`/`join`, not a RegExp: a key is literal text, and a key containing `+` or `.` must still be found. */
function redactSecrets(text, values) {
  let out = String(text ?? "");
  let removed = 0;
  for (const value of values || []) {
    const secret = String(value ?? "");
    if (!secret) continue;
    const parts = out.split(secret);
    removed += parts.length - 1;
    out = parts.join("<secret>");
  }
  return { text: out, removed };
}

const environmentFootprint = (environment) => {
  const names = ENVIRONMENT_NAMES.filter((name) => typeof environment?.[name] === "string" && environment[name].length > 0);
  return { names, present: names.length > 0 };
};

module.exports = { REGISTRY_STATE_KEY, ENVIRONMENT_NAMES, secretKey, loadRegistry, saveRegistry, validateApiKey, storeApiKey, readApiKey, hasApiKey, clearApiKey, redactSecrets, environmentFootprint };
