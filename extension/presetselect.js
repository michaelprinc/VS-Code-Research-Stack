"use strict";

/**
 * Preset → Copilot tool selection (0.3.14, HR-11 + HR-12, DD15-03, DD15-06, DD15-07).
 *
 * What this module does: it turns the reviewed GitHub entry a preset carries in
 * `extension/presets.json` into the exact text an operator can put in the workspace file the Copilot
 * harness reads for `mcpServers` — workspace-root `.mcp.json` — with the preset's named tool list in
 * the per-server `tools` field. It is pure: no `require("vscode")`, no network, no process, no
 * filesystem, no clock in any decision a test cannot pin. The command that asks the operator, writes
 * bytes and keeps the copy it replaced lives in `extension.js`; everything here is a function over a
 * preset object and a string.
 *
 * Boundary statement, in the terms `test/module-boundaries.test.js` measures: **no outbound capability is
 * in this module.** It imports no Node transport and no other extension module, opens no outbound connection,
 * starts no process, writes no file, and evaluates no dynamic code. `mergeIntoMcpFile` returns a string plus a plan;
 * the caller in `extension.js` is what shows that plan to the operator and writes bytes. That is why
 * `REVIEWED["presetselect.js"]` is an empty list, and why `reviewedNetworkBoundary` still names
 * `extension/updates.js` as the only packaged member with outbound capability. Being required by
 * `extension.js` does not hand this module any of the caller's reach. The wording above is chosen, not
 * casual: `scripts/verify_vsix.py` scans packaged bytes for transport and process names, and it cannot
 * tell a sentence from a call, so a header that names a transport would be reported as one.
 *
 * The rules this module exists to enforce:
 *   - HR-11: a selection's tool count **is** the length of its named list. A preset whose entry claims
 *     a different `toolsEstimate` is refused rather than trusted, because an unnamed estimate is what
 *     0.3.13 shipped (R15-03) and what retired `research-lab` / `research-lab-max` for good (DD15-07).
 *   - HR-12 / DD15-03: only the preset's chosen subset is written, in the shape the harness honours —
 *     the native `mcpServers` file, which has the per-server `tools` allow-list. The deprecated editor
 *     shape (`.vscode/mcp.json` with `servers`) has no tool-subset field, so a file in that shape is
 *     refused instead of being written with a selection that would be ignored.
 *   - No literal credential, ever: the token appears only as the environment reference
 *     `${GITHUB_PERSONAL_ACCESS_TOKEN}`, a credential-shaped value handed to this module is refused,
 *     and a credential-shaped value already in the file it would rewrite is refused too — the Toolkit
 *     does not produce bytes that carry somebody's token.
 *   - Preserve what the Toolkit did not write. A `github` entry the Toolkit did not write is left
 *     exactly as it is and the run is refused; an entry carrying this Toolkit's own marker may be
 *     replaced. A refusal is always "nothing was written", never "partly written".
 *   - Only surfaces this module can name are writable: an https URL on `api.githubcopilot.com` for the
 *     hosted server, and the vendor's own local command with its documented environment variables.
 *
 * What is **not** claimed here: that these names exist on a running GitHub MCP server. Every name and
 * count comes from the vendor catalog as recorded in
 * `research/github-mcp-tool-map-2026-11-17.md` — a name-list count, never a measurement; no `tools/list`
 * was captured on this host. It also does not claim that a server-side read-only switch is a permission
 * boundary: `X-MCP-Readonly` / `GITHUB_READ_ONLY` filter which tools the server offers, while the token
 * the operator chose decides what the account may actually do.
 */

const TOOLKIT_ID = "research-stack-toolkit";
/**
 * The marker field this Toolkit writes inside the server entry it wrote — the only way this module can
 * tell "an entry I wrote, which I may replace" from "an entry the operator wrote, which I must not".
 * A JSON file has no comments, so the marker is a real member named like a comment: the `//` prefix is
 * the vendor-visible signal that it is documentation, not configuration. `mergeIntoMcpFile` keeps the
 * file valid JSON either way.
 */
const MARKER_KEY = "//researchStackPreset";
/** The file the Copilot harness reads for `mcpServers`. Not `.vscode/mcp.json`: that shape has no tool allow-list. */
const MCP_FILE_NAME = ".mcp.json";
/** The only form a token may take in a file this Toolkit writes. */
const TOKEN_ENV_REFERENCE = "${GITHUB_PERSONAL_ACCESS_TOKEN}";
/** The vendor's own local server command and mode argument, named here rather than invented per call. */
const LOCAL_COMMAND = "github-mcp-server";
const LOCAL_ARGS = ["stdio"];
const REVIEWED_REMOTE_HOST = "api.githubcopilot.com";
const SERVER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const TOOLSET_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SELECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// GitHub's own published token shapes (PAT, OAuth, app, user-to-server) plus the fine-grained form.
const CREDENTIAL_PATTERNS = [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/, /\bgithub_pat_[A-Za-z0-9_]{12,}/];

/**
 * Named refusals, in the shape `bundles.js` uses: a refusal is a code the caller can branch on, not a
 * sentence to match. `error.code` is the code, `error.refusal` carries the same value under the name
 * the 0.3.9 bundle module used, so a caller written against either style sees the same refusal.
 */
const REFUSALS = {
  PRESET_INVALID: "preset-is-not-a-preset",
  SELECTION_ID_INVALID: "selection-id-invalid",
  NO_GITHUB_SELECTION: "preset-has-no-github-selection",
  GITHUB_SELECTION_AMBIGUOUS: "preset-has-multiple-github-surfaces",
  SELECTION_INCOMPLETE: "selection-does-not-state-its-surface",
  TOOL_LIST_MISSING: "selection-names-no-tools",
  TOOL_LIST_DUPLICATED: "selection-names-a-tool-twice",
  TOOL_NAME_UNSAFE: "unsafe-tool-name",
  TOOL_COUNT_MISMATCH: "selection-tool-count-does-not-match-its-named-list",
  TOOLSET_NAME_UNSAFE: "unsafe-toolset-name",
  EXCLUDE_OVERLAPS_SELECTION: "selection-excludes-a-tool-it-also-selects",
  REMOTE_URL_UNREVIEWED: "remote-url-is-not-the-reviewed-github-host",
  UNSAFE_SERVER_KEY: "unsafe-server-key",
  MERGE_OPTION_UNKNOWN: "merge-option-not-accepted",
  LITERAL_CREDENTIAL: "literal-credential-refused",
  MCP_FILE_NOT_TEXT: "mcp-file-is-not-text",
  MCP_FILE_NOT_JSON: "mcp-file-is-not-valid-json",
  MCP_FILE_NOT_OBJECT: "mcp-file-is-not-an-object",
  MCP_FILE_EDITOR_FORMAT: "mcp-file-uses-the-editor-server-format",
  MCP_SERVERS_NOT_AN_OBJECT: "mcp-servers-is-not-an-object",
  SERVER_ENTRY_NOT_A_SERVER: "server-entry-is-not-an-object",
  SERVER_ENTRY_NOT_WRITTEN_BY_TOOLKIT: "server-entry-not-written-by-this-toolkit",
  MERGE_VARIANT_UNKNOWN: "unknown-selection-shape",
  TARGET_IS_LINK: "target-is-a-link",
  TARGET_CHANGED_MID_RUN: "target-changed-after-it-was-reviewed",
  OUTSIDE_WORKSPACE: "outside-workspace",
  BACKUP_WRITE_REFUSED: "previous-copy-refused",
  MCP_FILE_WRITE_UNVERIFIED: "mcp-file-write-not-verified",
};

function refuse(refusal, message) {
  const error = new Error(message);
  error.code = refusal;
  error.refusal = refusal;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True for a value that has the shape of a real GitHub credential rather than a reference to one. */
function looksLikeCredential(value) {
  if (typeof value !== "string") return false;
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

/** An https URL on the one GitHub MCP host this Toolkit is reviewed to write, with no userinfo and no query. */
function reviewedRemoteUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== REVIEWED_REMOTE_HOST) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString();
}

/** A third-party entry this module can recognise as a GitHub MCP surface, from its id or its reviewed URL. */
function isGithubSurface(entry) {
  if (!isPlainObject(entry)) return false;
  const namedGithub = typeof entry.id === "string" && /^github(?:[-_][a-z0-9-]*)?$/.test(entry.id);
  const reviewedHost = isPlainObject(entry.server) && Boolean(reviewedRemoteUrl(entry.server.remoteUrl));
  return namedGithub || reviewedHost;
}

function assertServerKey(serverKey) {
  if (typeof serverKey !== "string" || !SERVER_KEY_PATTERN.test(serverKey) || serverKey === "//") {
    throw refuse(REFUSALS.UNSAFE_SERVER_KEY, `Server key ${JSON.stringify(serverKey)} is not a name this Toolkit will write into ${MCP_FILE_NAME}. A server key is one word of letters, digits, dot, hyphen or underscore.`);
  }
  return serverKey;
}

/**
 * The preset's GitHub selection, checked against its own named list before anything is written (HR-11).
 * Returns the selection, or `null` when the preset selects no GitHub surface at all — that is a real
 * answer (`research-max-no-github` and every narrow preset), not a failure.
 */
function selectionForPreset(preset) {
  if (!isPlainObject(preset) || typeof preset.id !== "string" || !preset.id) {
    throw refuse(REFUSALS.PRESET_INVALID, "Select a preset from the shipped preset registry before configuring tools for Copilot.");
  }
  const entries = Array.isArray(preset.thirdParty) ? preset.thirdParty : [];
  const candidates = entries.filter(isGithubSurface);
  if (!candidates.length) return null;
  if (candidates.length > 1) {
    throw refuse(REFUSALS.GITHUB_SELECTION_AMBIGUOUS, `Preset "${preset.id}" names ${candidates.length} GitHub MCP surfaces (${candidates.map((entry) => entry.id).join(", ")}). One preset writes one selection, so this one is refused and nothing was written.`);
  }
  return reviewedSelection(preset, candidates[0]);
}

/** One GitHub entry, validated field by field. Every refusal says which field failed and why it matters. */
function reviewedSelection(preset, entry) {
  const where = `preset "${preset.id}" surface "${entry.id}"`;
  if (typeof entry.id !== "string" || !SELECTION_ID_PATTERN.test(entry.id)) {
    throw refuse(REFUSALS.SELECTION_ID_INVALID, `${where}: a surface id is one lowercase word of letters, digits and hyphens.`);
  }
  const tools = entry.tools;
  if (!Array.isArray(tools) || !tools.length) {
    throw refuse(REFUSALS.TOOL_LIST_MISSING, `${where} names no tools. HR-11 allows only a surface whose exact tool names are listed, so this preset is refused and nothing was written.`);
  }
  const seen = new Set();
  for (const name of tools) {
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      throw refuse(REFUSALS.TOOL_NAME_UNSAFE, `${where} names tool ${JSON.stringify(name)}, which is not a tool name this Toolkit can write.`);
    }
    if (looksLikeCredential(name)) throw refuse(REFUSALS.LITERAL_CREDENTIAL, `${where} has a value with the shape of a real GitHub credential in its tool list. Nothing was written.`);
    if (seen.has(name)) throw refuse(REFUSALS.TOOL_LIST_DUPLICATED, `${where} names "${name}" more than once. A duplicated name hides a count error, so the count cannot be derived from the list.`);
    seen.add(name);
  }
  if (entry.toolsEstimate !== tools.length) {
    throw refuse(REFUSALS.TOOL_COUNT_MISMATCH, `${where} claims ${JSON.stringify(entry.toolsEstimate)} tools but names ${tools.length}. The count this Toolkit writes is the length of the named list, so an estimate that disagrees is refused instead of written (HR-11).`);
  }
  if (typeof entry.readOnly !== "boolean") {
    throw refuse(REFUSALS.SELECTION_INCOMPLETE, `${where} does not state read-only as true or false. The write decides whether the server's read-only switch is set, so an unstated one is refused.`);
  }
  const toolsets = entry.toolsets;
  if (!Array.isArray(toolsets) || !toolsets.length) {
    throw refuse(REFUSALS.SELECTION_INCOMPLETE, `${where} names no toolsets. The server-side selection and the named tool list are both written, so an empty toolset list is refused.`);
  }
  for (const name of toolsets) {
    if (typeof name !== "string" || !TOOLSET_NAME_PATTERN.test(name)) {
      throw refuse(REFUSALS.TOOLSET_NAME_UNSAFE, `${where} names toolset ${JSON.stringify(name)}, which is not a toolset name this Toolkit can write.`);
    }
  }
  if (!isPlainObject(entry.server)) {
    throw refuse(REFUSALS.SELECTION_INCOMPLETE, `${where} has no server block, so there is no reviewed URL or local command to write.`);
  }
  const remoteUrl = reviewedRemoteUrl(entry.server.remoteUrl);
  if (!remoteUrl) {
    throw refuse(REFUSALS.REMOTE_URL_UNREVIEWED, `${where} names remote URL ${JSON.stringify(entry.server.remoteUrl)}. This Toolkit writes only an https URL on ${REVIEWED_REMOTE_HOST}, so nothing was written.`);
  }
  const excluded = entry.server.excludeTools === undefined ? [] : entry.server.excludeTools;
  if (!Array.isArray(excluded)) {
    throw refuse(REFUSALS.TOOL_LIST_MISSING, `${where} carries a server exclude list that is not a list of names.`);
  }
  const excludedNames = [];
  for (const name of excluded) {
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      throw refuse(REFUSALS.TOOL_NAME_UNSAFE, `${where} excludes ${JSON.stringify(name)}, which is not a tool name this Toolkit can write.`);
    }
    if (seen.has(name)) throw refuse(REFUSALS.EXCLUDE_OVERLAPS_SELECTION, `${where} selects "${name}" and excludes it in the same surface. The two statements cannot both be honoured, so the surface is refused.`);
    excludedNames.push(name);
  }
  return {
    presetId: preset.id,
    selectionId: entry.id,
    label: typeof entry.label === "string" ? entry.label : entry.id,
    readOnly: entry.readOnly,
    // HR-11: the count is derived here, from the list; `toolsEstimate` was checked against it above and
    // is not used as a source anywhere in this module.
    toolCount: tools.length,
    tools: [...tools],
    toolsets: [...toolsets],
    excluded: excludedNames,
    remoteUrl,
  };
}

/** What the marker records: which preset wrote this entry, which selection inside it, and how many tools. */
function markerFor(selection, writtenAt) {
  const stamp = writtenAt === undefined ? new Date().toISOString() : writtenAt;
  if (typeof stamp !== "string" || !stamp) {
    throw refuse(REFUSALS.MERGE_OPTION_UNKNOWN, "A written-at value must be a readable timestamp or left out entirely.");
  }
  return {
    toolkit: TOOLKIT_ID,
    presetId: selection.presetId,
    selectionId: selection.selectionId,
    toolCount: selection.toolCount,
    readOnly: selection.readOnly,
    writtenAt: stamp,
  };
}

/**
 * True when a server entry carries this Toolkit's own marker. A marker alone is not enough: it must name
 * this Toolkit, because another tool could copy the field name. An entry without it is the operator's,
 * and this module never overwrites the operator's entry.
 */
function isToolkitWritten(entry) {
  if (!isPlainObject(entry)) return false;
  const marker = entry[MARKER_KEY];
  return isPlainObject(marker) && marker.toolkit === TOOLKIT_ID && typeof marker.presetId === "string";
}

/** The hosted entry: `type: "http"`, the reviewed URL, and the vendor's header selection controls. */
function remoteEntry(preset, { serverKey = "github", writtenAt } = {}) {
  const selection = selectionForPreset(preset);
  if (!selection) throw noSelection(preset);
  assertServerKey(serverKey);
  const headers = { "X-MCP-Toolsets": selection.toolsets.join(",") };
  if (selection.readOnly) headers["X-MCP-Readonly"] = "true";
  if (selection.excluded.length) headers["X-MCP-Exclude-Tools"] = selection.excluded.join(",");
  return {
    [serverKey]: {
      type: "http",
      url: selection.remoteUrl,
      headers,
      // The harness-side allow-list: the only per-server tool-subset field the native format has.
      tools: [...selection.tools],
      [MARKER_KEY]: markerFor(selection, writtenAt),
    },
  };
}

/**
 * The local entry: `type: "stdio"`, the vendor's own command, and the vendor's environment selection
 * controls. The token appears only as `${GITHUB_PERSONAL_ACCESS_TOKEN}`; no value is written.
 *
 * `GITHUB_TOOLS` is additive to `GITHUB_TOOLSETS` in the vendor server, so this pair can only widen what
 * the *server* offers, never narrow it — which is why the exact cap is the `tools` array the harness
 * honours, and why the read-only switch and the exclude list are written as well rather than instead.
 * Writing a local entry is not a claim that a local GitHub MCP binary is installed on this machine:
 * this module never looks at the machine.
 */
function localEntry(preset, { serverKey = "github", writtenAt } = {}) {
  const selection = selectionForPreset(preset);
  if (!selection) throw noSelection(preset);
  assertServerKey(serverKey);
  const env = {
    GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN_ENV_REFERENCE,
    GITHUB_TOOLSETS: selection.toolsets.join(","),
    GITHUB_TOOLS: selection.tools.join(","),
  };
  if (selection.readOnly) env.GITHUB_READ_ONLY = "true";
  if (selection.excluded.length) env.GITHUB_EXCLUDE_TOOLS = selection.excluded.join(",");
  return {
    [serverKey]: {
      type: "stdio",
      command: LOCAL_COMMAND,
      args: [...LOCAL_ARGS],
      env,
      tools: [...selection.tools],
      [MARKER_KEY]: markerFor(selection, writtenAt),
    },
  };
}

function noSelection(preset) {
  const id = isPlainObject(preset) && typeof preset.id === "string" ? preset.id : "this preset";
  return refuse(REFUSALS.NO_GITHUB_SELECTION, `Preset "${id}" selects no GitHub MCP surface, so there is no selection to write for Copilot. A preset with no GitHub surface configures nothing: leave no \`github\` entry in ${MCP_FILE_NAME}, and uncheck the GitHub server group in Chat: Open Customizations → Tools.`);
}

/** The five inputs this merge accepts. Anything else — a token slot included — is refused, so a credential cannot be handed in by mistake. */
const MERGE_OPTIONS = ["existingJson", "preset", "serverKey", "variant", "writtenAt"];
const CREDENTIAL_OPTION_NAMES = ["token", "accessToken", "pat", "personalAccessToken", "githubToken", "authorization"];

function assertMergeOptions(options) {
  for (const key of Object.keys(options)) {
    if (CREDENTIAL_OPTION_NAMES.includes(key)) {
      throw refuse(REFUSALS.LITERAL_CREDENTIAL, `This module has no input that accepts a credential. It writes ${TOKEN_ENV_REFERENCE} only, so ${key} is refused and nothing was produced.`);
    }
    if (!MERGE_OPTIONS.includes(key)) {
      throw refuse(REFUSALS.MERGE_OPTION_UNKNOWN, `Merge option ${JSON.stringify(key)} is not one of ${MERGE_OPTIONS.join(", ")}.`);
    }
  }
}

/**
 * Build the new file content and say what it does to the servers already in the file.
 *
 * `existingJson` is the file's current text, or `undefined` when there is no file yet. The result is
 * `{ content, plan }`: `content` is the whole file to write, `plan` states `added`, `replaced` and
 * `preserved` server names plus what was selected. Nothing here touches a filesystem — the write, the
 * copy of the bytes it replaces and the confirmation all belong to `extension.js`.
 */
function mergeIntoMcpFile(options = {}) {
  assertMergeOptions(options);
  const { existingJson, preset, serverKey = "github", variant = "remote", writtenAt } = options;
  const selection = selectionForPreset(preset);
  if (!selection) throw noSelection(preset);
  assertServerKey(serverKey);
  if (variant !== "remote" && variant !== "local") {
    throw refuse(REFUSALS.MERGE_VARIANT_UNKNOWN, `Selection shape ${JSON.stringify(variant)} is unknown: this Toolkit writes the hosted "remote" entry or the local "stdio" entry.`);
  }
  const written = variant === "local" ? localEntry(preset, { serverKey, writtenAt }) : remoteEntry(preset, { serverKey, writtenAt });

  let current;
  if (existingJson === undefined || existingJson === null || existingJson === "") current = {};
  else if (typeof existingJson !== "string") throw refuse(REFUSALS.MCP_FILE_NOT_TEXT, `${MCP_FILE_NAME} has to be read as text before anything can be merged into it.`);
  else {
    try { current = JSON.parse(existingJson); }
    catch (error) { throw refuse(REFUSALS.MCP_FILE_NOT_JSON, `${MCP_FILE_NAME} is not valid JSON (${error.message}). The Toolkit does not rewrite a file it cannot read, so the file was left exactly as it was.`); }
  }
  if (!isPlainObject(current)) {
    throw refuse(REFUSALS.MCP_FILE_NOT_OBJECT, `${MCP_FILE_NAME} has to hold one object with an "mcpServers" member. The file was left exactly as it was.`);
  }
  if (Object.hasOwn(current, "servers") && !Object.hasOwn(current, "mcpServers")) {
    throw refuse(REFUSALS.MCP_FILE_EDITOR_FORMAT, `${MCP_FILE_NAME} carries the deprecated editor "servers" shape. That shape has no per-server tool allow-list, so a tool selection written into it would be silently ignored — write the selection in ${MCP_FILE_NAME} ("mcpServers") instead, or filter tools in the Tools tab, and leave this file as it is.`);
  }
  if (current.mcpServers !== undefined && !isPlainObject(current.mcpServers)) {
    throw refuse(REFUSALS.MCP_SERVERS_NOT_AN_OBJECT, `The "mcpServers" member of ${MCP_FILE_NAME} is not an object, so no entry can be preserved or added safely. The file was left exactly as it was.`);
  }

  const existingServers = current.mcpServers === undefined ? {} : current.mcpServers;
  const target = existingServers[serverKey];
  if (target !== undefined) {
    if (!isPlainObject(target)) {
      throw refuse(REFUSALS.SERVER_ENTRY_NOT_A_SERVER, `The "${serverKey}" entry in ${MCP_FILE_NAME} is not a server object, so it cannot be classified. The file was left exactly as it was.`);
    }
    if (!isToolkitWritten(target)) {
      const untouched = Object.keys(existingServers).filter((key) => key !== serverKey);
      throw refuse(REFUSALS.SERVER_ENTRY_NOT_WRITTEN_BY_TOOLKIT, `The "${serverKey}" entry in ${MCP_FILE_NAME} was not written by this Toolkit — it carries no ${MARKER_KEY} marker — so it stays exactly as it is and this run is refused. ${untouched.length ? `The ${untouched.length} other server entry(ies) (${untouched.join(", ")}) are untouched. ` : ""}Choose a different server key, or edit that entry yourself, and run the command again. Nothing was written.`);
    }
  }

  // Every server the Toolkit did not write stays in place, in its original order; every top-level member
  // the Toolkit did not write stays too. JSON has no comments, so formatting is normalised but no value
  // this Toolkit did not write is edited or dropped.
  const servers = { ...existingServers, [serverKey]: written[serverKey] };
  const merged = {};
  for (const [key, value] of Object.entries(current)) if (key !== "mcpServers") merged[key] = value;
  merged.mcpServers = servers;

  const content = `${JSON.stringify(merged, null, 2)}\n`;
  const credential = CREDENTIAL_PATTERNS.map((pattern) => pattern.exec(content)).find(Boolean);
  if (credential) {
    throw refuse(REFUSALS.LITERAL_CREDENTIAL, `${MCP_FILE_NAME} already holds a value with the shape of a real GitHub credential ("${credential[0].slice(0, 8)}…"). The Toolkit writes ${TOKEN_ENV_REFERENCE} and never a token, and it will not produce a file that carries somebody else's secret forward. Replace it with an environment reference yourself and run the command again; nothing was written.`);
  }

  const preservedServers = Object.keys(existingServers).filter((key) => key !== serverKey);
  const preservedTopLevel = Object.keys(current).filter((key) => key !== "mcpServers");
  return {
    content,
    plan: {
      fileName: MCP_FILE_NAME,
      serverKey,
      variant,
      presetId: selection.presetId,
      selectionId: selection.selectionId,
      selectionLabel: selection.label,
      toolCount: selection.toolCount,
      tools: [...selection.tools],
      toolsets: [...selection.toolsets],
      readOnly: selection.readOnly,
      excludedCount: selection.excluded.length,
      excluded: [...selection.excluded],
      added: target === undefined ? [serverKey] : [],
      replaced: target === undefined ? [] : [serverKey],
      preserved: preservedServers,
      preservedTopLevel,
    },
  };
}

module.exports = {
  TOOLKIT_ID, MARKER_KEY, MCP_FILE_NAME, TOKEN_ENV_REFERENCE, LOCAL_COMMAND, LOCAL_ARGS, REFUSALS,
  refuse, looksLikeCredential, isToolkitWritten, selectionForPreset, remoteEntry, localEntry, mergeIntoMcpFile,
};
