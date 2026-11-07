"use strict";

/**
 * 0.3.10 — problem reports to the maintainer.
 *
 * The property that matters is not that a report is useful, it is that a report is useful *after* the
 * personal facts have been taken out of it. Every case below therefore asserts both halves: the fact the
 * maintainer needs is present, and the fact the operator did not agree to share is absent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const reports = require("../reports");

const HOME_WINDOWS = "C:\\Users\\Anna\\Documents\\Karmelitky Research\\notes.pdf";
const HOME_POSIX = "/home/anna/karmelitky/notes.pdf";
const WORKSPACE = "Karmelitky Research";

test("the maintainer address is the one the release names, in the module and in the report", () => {
  assert.equal(reports.MAINTAINER_EMAIL, "princ.michael@gmail.com");
  const report = reports.buildReport({ toolkitVersion: "0.3.10" });
  assert.ok(report.text.includes(reports.MAINTAINER_EMAIL), "the report tells the operator who it is for");
  assert.equal(reports.mailtoUri({ subject: "s", body: "b" }).uri.startsWith(`mailto:${reports.MAINTAINER_EMAIL}?`), true);
});

test("a Windows home directory leaves no folder name behind", () => {
  const { text, counts } = reports.redactText(`cannot read ${HOME_WINDOWS} during indexing`, { workspaceNames: [WORKSPACE] });
  assert.equal(counts.homePaths, 1, "the home directory is counted as itself, not as a generic path");
  assert.ok(!text.includes("Anna"), "the account name is gone");
  assert.ok(!text.includes("Karmelitky"), "the folder the operator named is gone, even though it sits inside the path");
  assert.ok(!text.includes("Documents"), "the path is redacted to the end of its line, deliberately");
  assert.ok(text.includes("<home>"), "and the report says what replaced it");
  assert.ok(text.startsWith("cannot read <home>"), "the failure itself survives");
  assert.ok(!text.includes("during indexing"), "the tail of the line goes with the path: a Windows path may contain spaces, so its end cannot be known, and guessing short would leave the folder name in the email");

  const bounded = reports.redactText("uv sync failed at C:\\Users\\Anna\\lab — network unreachable");
  assert.equal(bounded.counts.homePaths, 1);
  assert.ok(bounded.text.includes("<home> — network unreachable"), "when a separator names the end of the path, the error after it stays in the report");
});

test("a POSIX home directory and a bare absolute path are told apart", () => {
  const home = reports.redactText(`uv cache at ${HOME_POSIX} is unwritable`);
  assert.equal(home.counts.homePaths, 1);
  assert.ok(!home.text.includes("anna"));
  assert.ok(home.text.includes("uv cache at <home> is unwritable"));

  const other = reports.redactText("store: /srv/research/index.db failed");
  assert.equal(other.counts.absolutePaths, 1);
  assert.equal(other.counts.homePaths, 0, "a server path is not a home directory");
  assert.ok(other.text.includes("store: <path> failed"));
});

test("WSL and UNC paths are redacted as whole paths, not as prefixes", () => {
  const wsl = reports.redactText("failed at \\\\wsl$\\Ubuntu\\home\\anna\\lab\\plan.md");
  assert.ok(!wsl.text.includes("anna"));
  assert.ok(!wsl.text.includes("plan.md"));
  assert.equal(wsl.counts.absolutePaths, 1);

  const unc = reports.redactText("copy from \\\\nas\\karmelitky\\source.docx refused");
  assert.ok(!unc.text.includes("karmelitky"));
  assert.ok(unc.text.includes("<path>"));
});

test("a public URL stays in the report, because it is not a personal fact", () => {
  const { text, counts } = reports.redactText("GET https://marketplace.visualstudio.com/_apis/public/gallery/vscode/michaelprinc/research-stack-toolkit/latest answered 500");
  assert.ok(text.includes("https://marketplace.visualstudio.com/_apis/public/gallery/vscode/michaelprinc/research-stack-toolkit/latest"), "a failed download is only useful if the address is still there");
  assert.equal(counts.absolutePaths, 0, "a URL is not counted as a local path");
});

test("token-shaped material is removed and counted", () => {
  const labelled = reports.redactText("vsce rejected the credential token: glpat-abcdefghijklmnop123456");
  assert.equal(labelled.counts.secrets, 1);
  assert.ok(!labelled.text.includes("glpat-abcdefghijklmnop123456"));
  assert.ok(labelled.text.includes("token: <redacted>"), "the report keeps the fact that a token was involved");

  const blob = reports.redactText("sha mismatch 0123456789abcdef0123456789abcdef0123");
  assert.equal(blob.counts.secrets, 1);
  assert.ok(blob.text.includes("<redacted-token>"));

  const short = reports.redactText("bundle.json digest 2f6d9a");
  assert.equal(short.counts.secrets, 0, "an ordinary short hash is not a secret and is not removed");
});

test("the workspace name is removed everywhere it appears", () => {
  const { text, counts } = reports.redactText(`workspace ${WORKSPACE} opened\n${WORKSPACE} index failed`, { workspaceNames: [WORKSPACE, ""] });
  assert.equal(counts.workspaceNames, 2);
  assert.ok(!text.includes(WORKSPACE));
  assert.equal(text.split("<workspace>").length - 1, 2);
});

test("the log tail keeps the end and says how much it dropped", () => {
  const lines = Array.from({ length: 120 }, (_, index) => `line ${index}`);
  const tail = reports.tailLines(lines, { maxLines: 40 });
  assert.equal(tail.lines.length, 40);
  assert.equal(tail.lines[39], "line 119", "the last line is the interesting one");
  assert.equal(tail.lines[0], "line 80");
  assert.equal(tail.dropped, 80);
  const capped = reports.tailLines(Array.from({ length: 40 }, () => "x".repeat(300)), { maxLines: 40, maxBytes: 1000 });
  assert.ok(capped.lines.length < 40 && capped.dropped > 0, "a byte cap drops lines instead of truncating one mid-word");
  assert.deepEqual(reports.tailLines([]), { lines: [], dropped: 0 });
  assert.deepEqual(reports.tailLines(undefined), { lines: [], dropped: 0 });
});

test("the recent-failure ring is bounded in count and in length", () => {
  let ring = [];
  for (let index = 0; index < 40; index += 1) ring = reports.errorRing({ entries: ring, message: `failure ${index}`, kind: "researchToolkit.runReadingCheck" });
  assert.equal(ring.length, reports.MAX_ERROR_ENTRIES, "the ring holds 12 failures, not 40");
  assert.equal(ring[ring.length - 1].message, "failure 39");
  assert.equal(ring[0].message, "failure 28", "the oldest entries fall off");
  assert.ok(ring.every((entry) => /^\d{4}-\d{2}-\d{2}T/.test(entry.at)), "every failure carries a timestamp");
  assert.ok(ring.every((entry) => entry.kind === "researchToolkit.runReadingCheck"));
  const long = reports.errorRing({ entries: [], message: "e".repeat(5000) });
  assert.equal(long[0].message.length, 400, "one failure cannot become a 5 KB entry");
  assert.equal(reports.errorRing({ entries: [], message: null })[0].message, "unknown error");
});

test("a report states what is unknown instead of inventing it", () => {
  const report = reports.buildReport({ id: "r-20261107T100000Z", generatedAt: "2026-11-07T10:00:00.000Z", toolkitVersion: "0.3.10" });
  assert.ok(report.text.includes("Toolkit: 0.3.10 · Worker: not reported"));
  assert.ok(report.text.includes("VS Code: not reported"));
  assert.ok(report.text.includes("Update check: not run"));
  assert.ok(report.text.includes("No setup has run in this workspace, so there is no recorded status."));
  assert.ok(!report.text.includes("undefined"), "a missing field never prints the word undefined");
  assert.equal(report.truncated, false);
  assert.equal(report.bytes, Buffer.byteLength(report.text, "utf8"));
});

test("a full report carries the sections a maintainer needs and nothing personal", () => {
  const report = reports.buildReport({
    id: "r-20261107T100000Z",
    toolkitVersion: "0.3.10",
    workerVersion: "0.3.10",
    vscodeVersion: "1.145.2",
    platform: "win32",
    osRelease: "10.0.26100",
    architecture: "x64",
    nodeVersion: "v22.20.0",
    extensionPathKind: "installed from a local .vsix file",
    package: "basic",
    toolsPreset: "read-and-cite",
    workspaceLabel: WORKSPACE,
    setupStatusText: `Setup blocked: uv sync failed in ${WORKSPACE} (see ${HOME_WINDOWS})`,
    setupLogLines: ["2026-11-07T09:58:00Z step uv-sync running", `2026-11-07T09:59:00Z step uv-sync failed — ${HOME_WINDOWS}`],
    errors: [{ at: "2026-11-07T09:59:01Z", kind: "runReadingCheck", message: `could not read ${HOME_POSIX}` }],
    note: `The reading check stopped working after I moved the folder to ${WORKSPACE}.`,
    updateState: "update-available 0.3.11",
    workspaceNames: [WORKSPACE],
  });
  for (const heading of ["RESEARCH STACK TOOLKIT — PROBLEM REPORT", "ENVIRONMENT", "TOOLKIT STATE", "COMPONENT SETUP STATUS", "SETUP LOG TAIL", "RECENT FAILURES IN THIS SESSION", "WHAT THE OPERATOR REPORTED", "WHAT WAS REMOVED FROM THIS REPORT"]) {
    assert.ok(report.text.includes(heading), `${heading} is in the report`);
  }
  assert.ok(report.text.includes("VS Code: 1.145.2"));
  assert.ok(report.text.includes("win32 10.0.26100 x64"));
  assert.ok(report.text.includes("Update check: update-available 0.3.11"));
  assert.ok(report.text.includes("uv-sync failed"), "the failing step is named");
  assert.ok(report.text.includes("could not read <home>"), "the failure sentence survives redaction");
  assert.ok(report.text.includes("Report file") === false, "the file path is added by the email draft, not by the report");

  for (const leak of ["Anna", WORKSPACE, "C:\\Users", "/home/anna", "Karmelitky"]) {
    assert.ok(!report.text.includes(leak), `the report does not contain ${JSON.stringify(leak)}`);
  }
  assert.ok(report.text.includes("Workspace names: 3"), `the footer counts what was removed: ${report.counts.workspaceNames}`);
  assert.ok(report.counts.homePaths >= 2);
  assert.match(report.fileName, /^research-stack-report-r-20261107T100000Z\.txt$/);
  assert.ok(!report.fileName.includes("/") && !report.fileName.includes("\\"), "the file name is a name, not a path");
});

test("a report is capped, and says that it was capped", () => {
  const report = reports.buildReport({
    toolkitVersion: "0.3.10",
    setupLogLines: Array.from({ length: 4000 }, (_, index) => `line ${index} ${"y".repeat(20)}`),
    setupStatusText: "x".repeat(30_000),
  });
  assert.ok(report.bytes <= reports.MAX_REPORT_BYTES, `the report stays inside its stated budget (${report.bytes} bytes)`);
  assert.equal(report.truncated, true);
  assert.ok(report.text.includes(`[the report was truncated at ${reports.MAX_REPORT_BYTES} bytes]`), "and it says that it was cut");
  assert.ok(report.text.includes("WHAT WAS REMOVED FROM THIS REPORT"), "the footer survives the cut, because it is what tells the operator the report is safe to send");
});

test("the report id is a sortable stamp", () => {
  const id = reports.reportId(new Date("2026-11-07T10:00:00.000Z"));
  assert.equal(id, "r-20261107T100000Z");
  assert.equal(reports.reportFileName(id), "research-stack-report-r-20261107T100000Z.txt");
  assert.equal(reports.reportFileName("r-20261107T100000Z/../evil"), "research-stack-report-r-20261107T100000Zevil.txt");
});

test("the email draft names the report instead of carrying it", () => {
  const draft = reports.emailDraft({
    id: "r-20261107T100000Z", toolkitVersion: "0.3.10",
    headline: "Reading check fails on a DOCX with tracked changes",
    note: "It worked last week.", reportFilePath: "…/reports/research-stack-report-r-20261107T100000Z.txt",
  });
  assert.equal(draft.subject, "Research Stack Toolkit 0.3.10 — Reading check fails on a DOCX with tracked changes");
  assert.ok(draft.body.includes("Report id: r-20261107T100000Z"));
  assert.ok(draft.body.includes("It worked last week."));
  assert.ok(draft.body.includes("paste it under this line"), "the full report reaches the maintainer as a paste or an attachment, not as a URL");
  assert.ok(Buffer.byteLength(draft.body, "utf8") <= reports.MAX_MAILTO_BODY_BYTES);
  const longHeadline = reports.emailDraft({ headline: "h".repeat(500), toolkitVersion: "0.3.10" });
  assert.ok(longHeadline.subject.length <= "Research Stack Toolkit 0.3.10 — ".length + 80, "a subject cannot become a paragraph");
});

test("the mailto URI is built to fit, or it is refused", () => {
  const draft = reports.emailDraft({ id: "r-1", toolkitVersion: "0.3.10", headline: "setup failed", note: "uv sync timed out" });
  const mailto = reports.mailtoUri({ subject: draft.subject, body: draft.body });
  assert.equal(mailto.fits, true, `the normal draft fits (${mailto.bytes} bytes)`);
  assert.ok(mailto.bytes <= reports.MAX_MAILTO_URI_BYTES);
  assert.ok(mailto.uri.includes("%0D%0A"), "RFC 6068 wants a body line break to travel as CRLF");
  assert.ok(!mailto.uri.includes("%0A%0A") || mailto.uri.split("%0A%0A").length === 1, "no bare LF survives into the URI");

  const oversized = reports.mailtoUri({ subject: "s", body: "x".repeat(reports.MAX_MAILTO_BODY_BYTES + 1) });
  assert.equal(oversized.fits, false, "a body a mail client would silently truncate is reported, not shipped");
  assert.ok(oversized.uri.startsWith("mailto:"), "the URI is still returned so the operator can decide");

  const unicode = reports.mailtoUri({ subject: "Nástroj nefunguje — kontrola čtení", body: "Funguje jen bez mezer." });
  assert.equal(unicode.fits, true);
  assert.ok(!/[^\x20-\x7e]/.test(unicode.uri), "the URI is fully percent-encoded, so no client mangles the Czech");
});

test("nothing in this module can send anything", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "reports.js"), "utf8");
  for (const primitive of ["node:https", "node:http", "node:net", "node:tls", "node:fs", "node:child_process", "fetch(", "XMLHttpRequest", "WebSocket", "require("]) {
    assert.ok(!source.includes(primitive), `reports.js does not import or call ${primitive} — the write and the open belong to the controller, after the operator consents`);
  }
});
