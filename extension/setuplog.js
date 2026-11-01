"use strict";

/**
 * Installation status records.
 *
 * 0.3.5 recorded only successful steps, so a partial setup looked identical to a setup that had
 * never been attempted. 0.3.6 writes every attempt to an append-only log and keeps one current
 * status record that the control panel reads, so the verdict survives a panel reopen and an
 * editor reload.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const LOG_DIR = ".research-toolkit/logs";
const STATUS_NAME = "last-setup.json";
const LOG_PREFIX = "setup-";
const LOG_IGNORE_NAME = ".gitignore";
const KEEP_LOG_FILES = 12;
const STATUS_SCHEMA_VERSION = 1;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_LOG_LINES = 200;

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function paths(root) {
  const directory = path.join(path.resolve(root), LOG_DIR);
  return { directory, statusFile: path.join(directory, STATUS_NAME), ignoreFile: path.join(directory, LOG_IGNORE_NAME) };
}

/**
 * The log directory, as a real directory inside the workspace.
 *
 * A linked log directory (OneDrive, a dotfiles sync, a junction) would move the record outside
 * the workspace the toolkit is allowed to write in, so it is refused rather than followed. The
 * directory carries its own ignore file so the attempt log is never committed in a workspace that
 * was not created by the toolkit bootstrap.
 */
async function ensureDirectory(directory) {
  const current = path.resolve(directory);
  const info = await fs.lstat(current).catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(current, { recursive: true });
    return fs.lstat(current);
  });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${current} must be a real directory for the setup log; nothing was written.`);
  const ignore = path.join(current, LOG_IGNORE_NAME);
  if (await assertPlainFile(ignore) === null) await fs.writeFile(ignore, "# Setup logs are local diagnostics, not research data.\n*\n", "utf8");
  return current;
}

async function assertPlainFile(file) {
  const info = await fs.lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink()) throw new Error(`${file} is a link. The setup log refuses to write through links.`);
  if (!info.isFile()) throw new Error(`${file} is not a regular file. The setup log was not written.`);
  return info;
}

function serialize(record) {
  const payload = JSON.stringify(record, null, 2) + "\n";
  JSON.parse(payload);
  if (payload.length > MAX_STATUS_BYTES) throw new Error(`Installation status record would exceed ${MAX_STATUS_BYTES} bytes; it was not written.`);
  return payload;
}

/**
 * Append one attempt (or one plan summary) to the workspace setup log.
 *
 * `options.runStamp` keeps one plan in one file: without it a plan that spans minutes opens a new
 * log per second and the earlier attempts fall outside what the diagnostics action reads back.
 */
async function appendRecord(root, record, options = {}) {
  const { directory } = paths(root);
  await ensureDirectory(directory);
  const file = path.join(directory, `${LOG_PREFIX}${options.runStamp || stamp(options.now)}.jsonl`);
  await assertPlainFile(file);
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  return file;
}

/** Keep the attempt logs bounded: the newest `KEEP_LOG_FILES` files, and nothing else is touched. */
async function pruneLogs(root) {
  const { directory } = paths(root);
  let entries;
  try { entries = await fs.readdir(directory); } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  const logs = entries.filter((name) => name.startsWith(LOG_PREFIX) && name.endsWith(".jsonl")).sort();
  let removed = 0;
  for (const name of logs.slice(0, Math.max(0, logs.length - KEEP_LOG_FILES))) {
    const file = path.join(directory, name);
    if (await assertPlainFile(file) === null) continue;
    await fs.rm(file, { force: true });
    removed += 1;
  }
  return removed;
}

/** Write the current status record atomically: validated temp file, then rename. */
async function writeStatus(root, record, options = {}) {
  const { directory, statusFile } = paths(root);
  await ensureDirectory(directory);
  await assertPlainFile(statusFile);
  const payload = serialize({ schemaVersion: STATUS_SCHEMA_VERSION, ...record });
  // Unique per write, and a leftover from a killed process is cleared first, so a crash cannot
  // make the next attempt fail with EEXIST on a name it did not create.
  const temporary = path.join(directory, `${STATUS_NAME}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    await fs.rm(temporary, { force: true });
    await fs.writeFile(temporary, payload, { flag: "wx", encoding: "utf8" });
    await fs.rename(temporary, statusFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  await pruneLogs(root);
  return statusFile;
}

/**
 * Read the current status record.
 *
 * A missing record is "no record". A record that exists but cannot be read is reported as damaged
 * rather than silently becoming "nothing has run here", which would hide a real earlier failure.
 */
async function readStatus(root) {
  const { statusFile } = paths(root);
  try {
    const info = await assertPlainFile(statusFile);
    if (!info) return null;
    const record = JSON.parse(await fs.readFile(statusFile, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) return { damaged: true, statusFile };
    return { ...record, statusFile };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return { damaged: true, statusFile };
    throw error;
  }
}

/** Read the most recent log lines for the diagnostics action. */
async function readLog(root, limit = MAX_LOG_LINES) {
  const { directory } = paths(root);
  let entries;
  try { entries = await fs.readdir(directory); } catch (error) { if (error.code === "ENOENT") return { files: [], lines: [] }; throw error; }
  const files = entries.filter((name) => name.startsWith(LOG_PREFIX) && name.endsWith(".jsonl")).sort();
  const lines = [];
  // Every retained log is in scope: one plan is one file, and the diagnostics action has to
  // be able to show the attempts of the plan the operator is asking about.
  for (const name of files) {
    const file = path.join(directory, name);
    if (await assertPlainFile(file) === null) continue;
    const content = await fs.readFile(file, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try { lines.push({ file: name, record: JSON.parse(line) }); } catch { lines.push({ file: name, record: { unparsed: line.slice(0, 400) } }); }
    }
  }
  return { files, lines: lines.slice(-limit), directory };
}

module.exports = {
  pruneLogs, KEEP_LOG_FILES,
  LOG_DIR, STATUS_NAME, LOG_PREFIX, STATUS_SCHEMA_VERSION, MAX_LOG_LINES,
  paths, appendRecord, writeStatus, readStatus, readLog, stamp,
};
