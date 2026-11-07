"use strict";

/**
 * Problem reports to the maintainer (0.3.10).
 *
 * WHAT THIS IS FOR
 * The toolkit is used by people who are not developers. When a component step fails, the useful thing is
 * not a screenshot of the panel — it is the recorded setup status, the setup-log tail and the environment
 * the failure happened in. This module turns those into one plain-text report the operator can read before
 * anything leaves the machine, and hands it to their own mail client addressed to the maintainer.
 *
 * NOTHING IS SENT BY THIS EXTENSION.
 * There is no upload, no telemetry endpoint, no background request. The report is written to a file the
 * operator can open, copied to their clipboard, and — only after they choose it — a `mailto:` link is
 * handed to the operating system so their mail client composes the message. Whether the message is sent,
 * and what the operator adds to it, is their decision in their own mail client.
 *
 * WHAT IS TAKEN OUT BEFORE ANYONE SEES IT
 * Absolute paths, home directories, workspace folder names and anything that looks like a token are
 * replaced with a placeholder, and the count of each is written into the report itself so the operator can
 * see what was removed and why. The redaction is applied to the log tail and to the operator's own note
 * too: a research file name is a personal fact, and this module does not put one in an email.
 */

const MAINTAINER_EMAIL = "princ.michael@gmail.com";

// A mail client's `mailto:` handler is the narrow part of this path. Windows' ShellExecute has been
// reported at ~2 000 characters for years, and several clients refuse or silently truncate longer URLs.
// The body budget is therefore deliberately small, and the full report travels as a file or a paste.
const MAX_MAILTO_BODY_BYTES = 1400;
const MAX_MAILTO_URI_BYTES = 1800;
const MAX_REPORT_BYTES = 24_000;
const MAX_LOG_LINES = 40;
const MAX_ERROR_ENTRIES = 12;
const MAX_ERROR_CHARS = 400;
const MAX_NOTE_CHARS = 2000;

// A folder name is a personal fact. A path that stops at the first space leaves the most personal part
// of it — the folder the operator named — sitting in the report. Over-redacting is the right default
// here; the operator can always type a real path into the email themselves.
// A Windows path may contain spaces, so where it ends cannot always be known. Two shapes are tried,
// longest-safe first: a path that is followed by a sentence separator can be cut exactly, and the words
// after it — usually the actual error — stay in the report. A path with no separator is redacted to the
// end of its line, because the alternative is leaving the folder the operator named sitting in an email.
// The drive-letter pattern needs its left edge too: without it, `https://marketplace…` reads as the
// Windows path `s://marketplace…` and a failed download report loses the address it was about.
const HOME_PATTERNS = [
  /(^|[\s"'`(])(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\n"'`|<>]*?)(?=\s+(?:—|-{2}|;|,)\s)/gi,
  /(^|[\s"'`(])(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\n"'`|<>]*)/gi,
  /(^|[\s"'`(])((?:\/home|\/Users|\/root)\/[^\s"'`|<>)]+)/gi,
];
const WINDOWS_PATH_BOUNDED = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\n"'`|<>]*?(?=\s+(?:—|-{2}|;|,)\s)/g;
const WINDOWS_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\n"'`|<>]*/g;
const POSIX_PATH = /(?<![\w/.~-])\/(?:[^\s"'`|<>)]+\/?){1,}/g;
// `\\wsl$\…`, `\\wsl.localhost\Ubuntu\…` and an ordinary `\\server\share\…` are one shape: a machine
// name and a path on it. All three name a person's machine, so all three go.
const WSL_OR_UNC_PATH = /(?<![\w])(?:\\\\wsl(?:\$|[.][A-Za-z0-9_-]*)?|\\\\[A-Za-z0-9_.-]+)\\[^\n"'`|<>]*/g;
const SECRET_LABELLED = /\b(token|pat|password|passwd|secret|api[_ -]?key|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi;
// A token is long, mixes letters and digits, and has no slash in it. The slash matters: without that
// exclusion a Marketplace URL — `com/_apis/public/gallery/vscode/…` — is 32 characters of exactly this
// shape, and the report loses the address the maintainer needed.
const SECRET_BLOB = /\b(?:[0-9a-f]{24,}|(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[a-z])[A-Za-z0-9+_-]{32,})\b/g;

/**
 * Replace the personal facts in a block of text.
 * Order matters: a home directory is also an absolute path, so it is matched first and reported separately.
 */
function redactText(text, { workspaceNames = [] } = {}) {
  let out = String(text === undefined || text === null ? "" : text);
  const counts = { homePaths: 0, absolutePaths: 0, workspaceNames: 0, secrets: 0 };

  for (const pattern of HOME_PATTERNS) {
    out = out.replace(pattern, (match, lead) => { counts.homePaths += 1; return `${lead || ""}<home>`; });
  }
  for (const pattern of [WSL_OR_UNC_PATH, WINDOWS_PATH_BOUNDED, WINDOWS_PATH]) {
    out = out.replace(pattern, (match) => { counts.absolutePaths += 1; return "<path>"; });
  }
  out = out.replace(POSIX_PATH, (match) => {
    // A URL is a public address, not a local path; leaving it in keeps a failed download report useful.
    if (/^\/\//.test(match) || /^\/(api|_apis)\//.test(match)) return match;
    counts.absolutePaths += 1;
    return "<path>";
  });
  for (const name of workspaceNames) {
    const label = String(name || "").trim();
    if (label.length < 2) continue;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), () => { counts.workspaceNames += 1; return "<workspace>"; });
  }
  out = out.replace(SECRET_LABELLED, (match) => { counts.secrets += 1; return match.replace(/[:=].*$/, ": <redacted>"); });
  out = out.replace(SECRET_BLOB, (match) => { counts.secrets += 1; return "<redacted-token>"; });

  return { text: out, counts };
}

/** Keep the end of a log, because the end is where the failure is. Say how much was dropped. */
function tailLines(lines, { maxLines = MAX_LOG_LINES, maxBytes = 6000 } = {}) {
  const kept = [];
  let bytes = 0;
  let dropped = 0;
  for (const line of [...(lines || [])].reverse()) {
    const text = String(line);
    if (kept.length >= maxLines) { dropped += 1; continue; }
    if (bytes + text.length + 1 > maxBytes) { dropped += 1; continue; }
    kept.unshift(text);
    bytes += text.length + 1;
  }
  return { lines: kept, dropped };
}

function formatLogEntry(entry) {
  if (!entry || typeof entry !== "object") return String(entry || "");
  const record = entry.record || entry;
  const when = entry.at || record.at || record.timestamp || "";
  return `${when ? `${when} ` : ""}${record.kind || "record"}${record.stepId ? ` ${record.stepId}` : ""} ${record.status || ""}${record.detail ? ` — ${record.detail}` : ""}`.trim();
}

/** A bounded ring of recent failures. Oldest entries fall off; nothing here is ever written to disk. */
function errorRing({ entries = [], message, kind = "error", at = null, max = MAX_ERROR_ENTRIES, maxChars = MAX_ERROR_CHARS } = {}) {
  const next = entries.slice(-max);
  const text = String(message === undefined || message === null ? "unknown error" : message).slice(0, maxChars);
  next.push({ at: at || new Date().toISOString(), kind: String(kind).slice(0, 40), message: text });
  while (next.length > max) next.shift();
  return next;
}

function reportId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `r-${stamp}`;
}

function reportFileName(id) {
  return `research-stack-report-${String(id).replace(/[^A-Za-z0-9-]/g, "")}.txt`;
}

/**
 * Cut a string to a byte budget without ending on half a UTF-8 sequence. A report that ends in a
 * replacement character is how a Czech folder name turns into mojibake in somebody's email.
 */
function truncateToBytes(text, limit) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= limit) return { text, truncated: false };
  let cut = buffer.subarray(0, Math.max(0, limit));
  let decoded = cut.toString("utf8");
  while (decoded.endsWith("\uFFFD")) {
    cut = cut.subarray(0, cut.length - 1);
    decoded = cut.toString("utf8");
  }
  return { text: decoded, truncated: true };
}

/**
 * Build the report. Every field is optional; a missing fact is written as "not reported" rather than
 * guessed at, because a report that invents an environment value is worse than one that admits it is blank.
 */
function buildReport({
  id = reportId(),
  generatedAt = new Date().toISOString(),
  toolkitVersion,
  workerVersion,
  vscodeVersion,
  platform,
  osRelease,
  architecture,
  nodeVersion,
  extensionPathKind,
  package: packageId,
  toolsPreset,
  workspaceLabel,
  setupStatusText,
  setupLogLines,
  errors,
  note,
  updateState,
  workspaceNames = [],
} = {}) {
  const sections = [];
  const redactionTargets = [];

  sections.push([
    "RESEARCH STACK TOOLKIT — PROBLEM REPORT",
    `Report: ${id}`,
    `Generated: ${generatedAt}`,
    `Toolkit: ${toolkitVersion || "not reported"} · Worker: ${workerVersion || "not reported"}`,
    "This report was written by the toolkit on this machine. Nothing was sent anywhere to produce it.",
  ].join("\n"));

  sections.push([
    "ENVIRONMENT",
    `VS Code: ${vscodeVersion || "not reported"}`,
    `Platform: ${platform || "not reported"} ${osRelease || ""} ${architecture || ""}`.trimEnd(),
    `Node: ${nodeVersion || "not reported"}`,
    `Install: ${extensionPathKind || "not reported"}`,
    updateState ? `Update check: ${updateState}` : "Update check: not run",
  ].join("\n"));

  sections.push([
    "TOOLKIT STATE",
    `Package preference: ${packageId || "not reported"}`,
    `Tools preset: ${toolsPreset || "package default"}`,
    `Workspace: ${workspaceLabel || "not reported"}`,
  ].join("\n"));

  if (setupStatusText) {
    sections.push(["COMPONENT SETUP STATUS (as the panel shows it)", String(setupStatusText)].join("\n"));
  } else {
    sections.push("COMPONENT SETUP STATUS\nNo setup has run in this workspace, so there is no recorded status.");
  }

  const tail = tailLines(setupLogLines);
  if (tail.lines.length) {
    sections.push([
      `SETUP LOG TAIL (${tail.lines.length} line(s)${tail.dropped ? `, ${tail.dropped} older line(s) dropped` : ""})`,
      ...tail.lines,
    ].join("\n"));
  }

  const recent = (errors || []).slice(-MAX_ERROR_ENTRIES);
  if (recent.length) {
    sections.push([
      `RECENT FAILURES IN THIS SESSION (${recent.length})`,
      ...recent.map((entry) => `${entry.at} [${entry.kind}] ${entry.message}`),
    ].join("\n"));
  }

  if (note && String(note).trim()) {
    const trimmed = String(note).trim().slice(0, MAX_NOTE_CHARS);
    sections.push([
      "WHAT THE OPERATOR REPORTED",
      trimmed,
      String(note).trim().length > trimmed.length ? "(the note was trimmed to 2000 characters)" : "",
    ].filter(Boolean).join("\n"));
  }

  redactionTargets.push(...sections);
  if (tail.lines.length) redactionTargets.push(...tail.lines);
  redactionTargets.push(...recent.map((entry) => entry.message));
  if (note) redactionTargets.push(String(note));
  if (setupStatusText) redactionTargets.push(String(setupStatusText));
  if (workspaceLabel) redactionTargets.push(String(workspaceLabel));

  const redacted = sections.map((section) => redactText(section, { workspaceNames }));
  const counts = redacted.reduce((total, entry) => {
    for (const key of Object.keys(total)) total[key] += entry.counts[key];
    return total;
  }, { homePaths: 0, absolutePaths: 0, workspaceNames: 0, secrets: 0 });

  const footer = [
    "WHAT WAS REMOVED FROM THIS REPORT",
    `Absolute paths: ${counts.absolutePaths} · Home directories: ${counts.homePaths} · Workspace names: ${counts.workspaceNames} · Token-shaped strings: ${counts.secrets}`,
    "The toolkit replaces these with <path>, <home>, <workspace> and <redacted> before you see the report.",
    "If you want the maintainer to have a real path, type it into the email yourself.",
    "",
    `Send it to: ${MAINTAINER_EMAIL}`,
  ].join("\n");

  // The cap covers the whole file, footer included. A report that promises 24 000 bytes and delivers
  // 24 300 has broken a promise nobody notices until a mail client trims the tail off.
  const truncationNote = `\n\n[the report was truncated at ${MAX_REPORT_BYTES} bytes]`;
  const limit = Math.max(0, MAX_REPORT_BYTES - Buffer.byteLength(footer, "utf8") - Buffer.byteLength(truncationNote, "utf8") - 3);
  const capped = truncateToBytes(redacted.map((entry) => entry.text).join("\n\n"), limit);
  const text = `${capped.text}${capped.truncated ? truncationNote : ""}\n\n${footer}\n`;

  return {
    id,
    fileName: reportFileName(id),
    text,
    counts,
    truncated: capped.truncated,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

/**
 * The short message body. It never carries the report: it names it, says where the file is, and leaves
 * room for the operator's own sentence. A body that tries to carry 20 KB of log is a body no mail client
 * will accept through a `mailto:` link.
 */
function emailDraft({ id, toolkitVersion, headline, note, reportFilePath, subjectPrefix = "Research Stack Toolkit" } = {}) {
  const subject = `${subjectPrefix} ${toolkitVersion || ""} — ${String(headline || "a problem").slice(0, 80)}`.trim();
  const opening = String(note || "").trim().slice(0, 400);
  const bodyLines = [
    opening || "I am sending the report the Toolkit Controls panel wrote on my machine.",
    "",
    `Report id: ${id || "not reported"}`,
    reportFilePath ? `Report file: ${reportFilePath}` : "Report file: not written",
    "The full report is also on my clipboard — paste it under this line if you cannot attach the file.",
    "",
    "--- report begins ---",
  ];
  return { subject, body: bodyLines.join("\n") };
}

/**
 * Build the `mailto:` URI. Returns `fits: false` with the byte count instead of emitting a URI a mail
 * client would truncate in a way nobody would notice.
 *
 * The budget is not invented: Electron documents `shell.openExternal` as "Max 2081 characters on Windows",
 * and that is the call VS Code's `env.openExternal` ends in on the desktop. RFC 6068 §5 requires a body
 * line break to travel as `%0D%0A`, so a bare `%0A` is normalised before the URI leaves this function.
 */
function mailtoUri({ to = MAINTAINER_EMAIL, subject = "", body = "" } = {}) {
  const query = `subject=${encodeURIComponent(subject).replace(/\r?\n/g, "%0D%0A")}`
    + `&body=${encodeURIComponent(body).replace(/%0A/g, "%0D%0A")}`;
  const uri = `mailto:${to}?${query}`;
  const bytes = Buffer.byteLength(uri, "utf8");
  return { uri, bytes, fits: bytes <= MAX_MAILTO_URI_BYTES && Buffer.byteLength(body, "utf8") <= MAX_MAILTO_BODY_BYTES };
}

module.exports = {
  MAINTAINER_EMAIL,
  MAX_MAILTO_BODY_BYTES,
  MAX_MAILTO_URI_BYTES,
  MAX_REPORT_BYTES,
  MAX_LOG_LINES,
  MAX_ERROR_ENTRIES,
  redactText,
  tailLines,
  formatLogEntry,
  errorRing,
  reportId,
  reportFileName,
  buildReport,
  emailDraft,
  mailtoUri,
};
