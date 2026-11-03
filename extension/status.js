"use strict";

/**
 * Installation outcome and human diagnostics text.
 *
 * Pure module: it turns recorded evidence into a verdict. Nothing here runs a process or reads a
 * file, which is what makes the GUI wording testable without an editor.
 */

const OUTCOMES = ["success", "partial", "failed", "blocked", "cancelled", "not-run"];

const OUTCOME_LABEL = {
  success: "Installation complete",
  partial: "Installation incomplete",
  failed: "Installation failed",
  blocked: "Setup blocked",
  cancelled: "Setup cancelled",
  "not-run": "No component setup has run in this workspace yet",
};

function durationText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, "0")} s`;
}

function timeText(value) {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "not recorded" : parsed.toLocaleString();
}

/**
 * Compute the outcome from evidence.
 *
 * A step counts as installed only when its artifacts were verified after the run, so a command
 * that exits 0 and leaves no interpreter cannot produce "Installation complete".
 */
function outcomeOf(record) {
  if (!record) return "not-run";
  const steps = Array.isArray(record.steps) ? record.steps : [];
  if (record.preflight && record.preflight.ok === false && !steps.some((step) => step.status === "installed" || step.status === "skipped")) return "blocked";
  if (steps.some((step) => step.status === "cancelled") && !steps.some((step) => step.status === "failed")) return "cancelled";
  if (!steps.length) return record.preflight && record.preflight.ok === false ? "blocked" : "not-run";
  const verified = steps.filter((step) => step.status === "installed" || step.status === "skipped");
  const troubled = steps.filter((step) => step.status === "failed" || step.status === "blocked" || step.status === "cancelled");
  const unverified = steps.filter((step) => step.status === "installed" && step.artifacts && step.artifacts.verified === false);
  if (verified.length === 0 && troubled.length === 0 && unverified.length === 0) return "not-run";
  if (verified.length === 0) return "failed";
  if (troubled.length || unverified.length) return "partial";
  return "success";
}

function firstProblem(record) {
  const steps = Array.isArray(record && record.steps) ? record.steps : [];
  const blocker = record && record.preflight && Array.isArray(record.preflight.checks)
    ? record.preflight.checks.find((check) => check.status === "fail") : null;
  if (blocker) return { source: "preflight", label: blocker.label, detail: blocker.detail, action: blocker.action };
  const failed = steps.find((step) => step.status === "failed");
  if (failed) return { source: "step", label: failed.label || failed.id, detail: failed.error || "no error text was captured", action: failed.hint || "Retry this step, then check the setup log." };
  const blocked = steps.find((step) => step.status === "blocked");
  if (blocked) return { source: "step", label: blocked.label || blocked.id, detail: `Blocked because ${blocked.blockedBy || "a prerequisite step"} did not complete.`, action: "Fix the prerequisite step, then retry." };
  const unverified = steps.find((step) => step.status === "installed" && step.artifacts && step.artifacts.verified === false);
  if (unverified) {
    const missing = (unverified.artifacts.missing || []);
    return {
      source: "step", label: unverified.label || unverified.id,
      detail: `Recorded as installed, but ${missing.length || "some of the"} file(s) it should have produced are missing${missing.length ? `: ${missing.join(", ")}` : ""}.`,
      action: "Repair this step.",
    };
  }
  return null;
}

/** One sentence, one full stop, bounded length — the headline must stay readable. */
function sentence(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/**
 * The one-line verdict the panel shows.
 *
 * The headline names how many steps are trustworthy and which ones are not; the detail belongs to
 * the step rows below it, so a long tool error cannot turn the headline into a paragraph.
 * `toolkitVersion` qualifies a verdict that a previous release recorded.
 */
function outcomeLine(record, { toolkitVersion } = {}) {
  const outcome = outcomeOf(record);
  if (outcome === "not-run") return { outcome, line: OUTCOME_LABEL["not-run"] };
  const steps = Array.isArray(record && record.steps) ? record.steps : [];
  const troubled = steps.filter((step) => ["failed", "blocked", "cancelled"].includes(step.status)
    || (step.status === "installed" && step.artifacts && step.artifacts.verified === false));
  const verified = steps.filter((step) => (step.status === "installed" || step.status === "skipped") && !troubled.includes(step));
  const names = troubled.slice(0, 3).map((step) => step.label || step.id);
  const named = names.length ? ` (${names.join(", ")}${troubled.length > names.length ? ", …" : ""})` : "";
  let line;
  if (outcome === "success") line = `Installation complete — ${verified.length} component step(s) verified.`;
  else if (outcome === "cancelled") line = `Setup cancelled — ${verified.length} step(s) already completed were kept.`;
  else if (outcome === "blocked") line = `Setup blocked — ${sentence(firstProblem(record) ? firstProblem(record).detail : "a preflight check failed")}.`;
  else if (outcome === "failed") {
    const problem = firstProblem(record);
    line = `Installation failed — ${problem ? `${problem.label}: ${sentence(problem.detail)}` : "no component step completed"}.`;
  } else {
    line = `Installation incomplete — ${verified.length} step(s) verified, ${troubled.length} need attention${named}.`;
  }
  const coverage = record.packageSteps;
  if (coverage && Number.isFinite(coverage.total) && Number.isFinite(coverage.installed) && coverage.installed < coverage.total) {
    // A record made by a retry covers part of the package; the headline has to say how much.
    line += ` ${coverage.installed} of ${coverage.total} package steps are installed in this workspace.`;
  }
  // A step that installed through the `--frozen` fallback is installed, but not from the lockfile this
  // build shipped. The headline must not read as an unqualified success.
  const fallbacks = steps.filter((step) => step.lockFallback);
  if (fallbacks.length) {
    const names = fallbacks.map((step) => step.label || step.id).join(", ");
    line += ` ${fallbacks.length} step(s) installed through a lockfile fallback (${names}) — this host's uv refused the shipped lockfile; see that step's evidence.`;
  }
  if (toolkitVersion && record.toolkitVersion && record.toolkitVersion !== toolkitVersion) {
    line += ` Recorded by toolkit ${record.toolkitVersion}; this release has not run in this workspace yet.`;
  }
  return { outcome, line };
}

function stepRow(step) {
  const statusText = {
    installed: step.artifacts && step.artifacts.verified === false ? "installed, artifacts missing" : "installed",
    skipped: "already current and verified",
    repaired: "repaired",
    failed: "failed",
    blocked: "blocked",
    cancelled: "cancelled",
  }[step.status] || step.status;
  const parts = [statusText];
  if (step.status === "failed" && Number.isInteger(step.exitCode)) parts.push(`exit ${step.exitCode}`);
  if (step.attempts > 1) parts.push(`${step.attempts} attempts`);
  if (step.blockedBy) parts.push(`blocked by ${step.blockedBy}`);
  if (step.lockFallback) parts.push("lockfile fallback used");
  return {
    id: step.id,
    label: step.label || step.id,
    status: step.status,
    statusText: parts.join(" · "),
    duration: durationText(step.durationMs),
    attemptedAt: timeText(step.finishedAt || step.startedAt),
    error: step.error || (step.artifacts && step.artifacts.verified === false ? `missing: ${(step.artifacts.missing || []).join(", ")}` : ""),
    command: step.command || "",
    artifactsText: artifactsText(step),
    note: step.lockFallback
      ? `installed through a lockfile fallback: ${step.lockFallback.problems && step.lockFallback.problems.length ? step.lockFallback.problems.join("; ") : "this host's uv refused the shipped lockfile and the toolkit's own check of the same pair agreed"}`
      : "",
    hint: step.hint || "",
  };
}

/** What the card says about the files a step was supposed to produce. */
function artifactsText(step) {
  if (!step.artifacts) return "not verified";
  if (step.artifacts.verified === false) {
    const missing = step.artifacts.missing || [];
    return `missing: ${missing.join(", ") || "unknown"}`;
  }
  const count = step.artifacts.observedCount || step.artifacts.count || (step.artifacts.files || []).length;
  return `${count || 1} file(s) verified`;
}

/** Plain text for "Copy installation diagnostics": everything an operator pastes into a report. */
function diagnosticsText(record, log) {
  if (!record) return "Component setup status: no setup has run in this workspace yet.";
  const verdict = outcomeLine(record);
  const lines = [
    `Research Stack component setup — ${verdict.line}`,
    `Package: ${record.package || "unknown"} · Toolkit: ${record.toolkitVersion || "unknown"} · Workspace: ${record.workspaceFolder || "unknown"}`,
    `Started: ${timeText(record.startedAt)} · Finished: ${timeText(record.finishedAt)} · Duration: ${durationText(record.durationMs)}`,
  ];
  if (record.hostTools && record.hostTools.length) {
    lines.push("Host tools:");
    for (const tool of record.hostTools) {
      // A tool that was found but cannot be used must not read as "resolved from …".
      if (tool.path && (tool.verified === false || tool.usable === false)) {
        lines.push(`  ${tool.name}: not usable — ${tool.reason || (tool.path ? `found at ${tool.path}` : "no candidate resolved")}`);
      } else {
        lines.push(tool.path ? `  ${tool.name}: ${tool.version || "version not reported"} at ${tool.path} (resolved from ${tool.source})`
          : `  ${tool.name}: not found — ${tool.reason || "no candidate resolved"}`);
      }
    }
  }
  if (record.preflight && Array.isArray(record.preflight.checks)) {
    lines.push("Preflight:");
    for (const check of record.preflight.checks) lines.push(`  ${check.label}: ${check.status}${check.detail ? ` — ${check.detail}` : ""}${check.action ? ` → ${check.action}` : ""}`);
  }
  lines.push("Steps:");
  for (const step of record.steps || []) {
    const row = stepRow(step);
    const identity = row.label && row.label !== row.id ? `${row.label} (${row.id})` : row.id;
    lines.push(`  ${identity}: ${row.statusText} · ${row.duration} · last attempt ${row.attemptedAt}`);
    if (row.command) lines.push(`    command: ${row.command}`);
    if (row.error) lines.push(`    error: ${row.error}`);
    if (row.note) lines.push(`    note: ${row.note}`);
    if (row.hint) lines.push(`    next action: ${row.hint}`);
  }
  if (log && Array.isArray(log.lines) && log.lines.length) {
    lines.push(`Setup log (${log.files.length} file(s)): ${log.lines.slice(-8).map((entry) => `${entry.record.kind || "record"} ${entry.record.stepId || ""} ${entry.record.status || ""}`.trim()).join("; ")}`);
  }
  if (record.logFile) lines.push(`Setup log file: ${record.logFile}`);
  return lines.join("\n");
}

module.exports = { OUTCOMES, OUTCOME_LABEL, outcomeOf, outcomeLine, firstProblem, stepRow, artifactsText, diagnosticsText, durationText, timeText };
