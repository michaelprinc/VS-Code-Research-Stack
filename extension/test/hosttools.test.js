"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const hosttools = require("../hosttools");
const { resolveHostTool, knownLocations, pathEntries, pathScan, compareVersions, versionOf, clearHostToolCache, resolverFrom, settingProblem } = hosttools;

const node = process.execPath;

async function fakeHost(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-host-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const onPath = path.join(root, "bin");
  const known = path.join(root, ".local", "bin");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(onPath, { recursive: true }); await fs.mkdir(known, { recursive: true }); await fs.mkdir(workspace, { recursive: true });
  const write = async (directory, name, body) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, body);
    await fs.chmod(file, 0o755);
    return file;
  };
  return { root, onPath, known, workspace, write, env: { PATH: `${onPath}${path.delimiter}relative-entry`, HOME: root } };
}

test("PATH entries are filtered to absolute ones and the known-location list is bounded and documented (R6-01, R6-02)", () => {
  const entries = pathEntries({ PATH: `/a${path.delimiter}relative${path.delimiter}/b` });
  assert.deepEqual(entries, ["/a", "/b"]);
  for (const platform of ["win32", "darwin", "linux"]) {
    const list = knownLocations(platform, { USERPROFILE: "C:\\u", LOCALAPPDATA: "C:\\l", APPDATA: "C:\\a", HOME: "/home/u", XDG_BIN_HOME: "" });
    assert.ok(list.length >= 5, `${platform} has documented locations`);
    assert.ok(list.every((entry) => typeof entry === "string" && entry.length > 1), "no empty or recursive patterns");
  }
});

test("a tool found in a documented location is resolved with its source and version (T6-01)", async (t) => {
  const host = await fakeHost(t);
  await fs.mkdir(host.known, { recursive: true });
  const file = await host.write(host.known, "uv", "#!/bin/sh\necho 'uv 0.7.3'\n");
  clearHostToolCache();
  const result = await resolveHostTool("uv", { roots: [host.workspace], env: { PATH: host.onPath, HOME: host.root }, minimumVersion: "0.5.0" });
  assert.equal(result.path, await fs.realpath(file));
  assert.equal(result.source, "known-location");
  assert.equal(result.version, "0.7.3");
  assert.equal(result.verified, true);
  assert.equal(result.minimumVersion, "0.5.0");
  assert.ok(result.searched.pathEntries >= 1 && result.searched.knownLocations >= 5);
});

test("nothing found is reported with the searched categories and an actionable hint (T6-02)", async (t) => {
  const host = await fakeHost(t);
  clearHostToolCache();
  const result = await resolveHostTool("uv", {
    roots: [host.workspace],
    env: { PATH: host.onPath, HOME: path.join(host.root, "empty-home") },
  });
  assert.equal(result.path, null);
  assert.equal(result.verified, false);
  assert.match(result.reason, /was not found\. Searched: 0 configured path\(s\), 1 absolute PATH entr\(ies\), \d+ documented install location\(s\)/);
  assert.match(result.hint, /researchStack\.uvPath/);
});

test("a configured path is honoured, and a workspace-local or missing one is refused (T6-03)", async (t) => {
  const host = await fakeHost(t);
  const configured = await host.write(host.known, "uv", "#!/bin/sh\necho 'uv 0.9.1'\n");
  clearHostToolCache();
  const honoured = await resolveHostTool("uv", { roots: [host.workspace], configuredPath: configured, env: { PATH: "", HOME: host.root } });
  assert.equal(honoured.source, "setting");
  assert.equal(honoured.version, "0.9.1");

  clearHostToolCache();
  const inside = await host.write(host.workspace, "uv", "#!/bin/sh\necho 'uv 1.0'\n");
  const refused = await resolveHostTool("uv", { roots: [host.workspace], configuredPath: inside, env: { PATH: "", HOME: path.join(host.root, "no-home") } });
  assert.equal(refused.path, null, "a workspace-local executable is not a host tool");
  assert.deepEqual(refused.workspaceRefusals, [await fs.realpath(inside)]);

  clearHostToolCache();
  const missing = await resolveHostTool("uv", { roots: [host.workspace], configuredPath: path.join(host.root, "nope", "uv"), env: { PATH: "", HOME: path.join(host.root, "no-home") } });
  assert.equal(missing.path, null);
});

test("a tool whose version command fails is reported unverified, not installed (T6-04)", async (t) => {
  const host = await fakeHost(t);
  const file = await host.write(host.known, "uv", "#!/bin/sh\nsleep 5\n");
  clearHostToolCache();
  const result = await resolveHostTool("uv", { roots: [host.workspace], env: { PATH: host.known, HOME: host.root }, versionTimeoutMs: 300 });
  assert.equal(result.path, await fs.realpath(file));
  assert.equal(result.verified, false);
  assert.match(result.reason, /version command failed/);
  assert.match(result.hint, /researchStack\.uvPath/);
});

test("a version below the registry minimum is reported with found and required (T6-05)", async (t) => {
  const host = await fakeHost(t);
  await host.write(host.known, "uv", "#!/bin/sh\necho 'uv 0.4.9'\n");
  clearHostToolCache();
  const result = await resolveHostTool("uv", { roots: [host.workspace], env: { PATH: host.known, HOME: host.root }, minimumVersion: "0.5.0" });
  assert.equal(result.verified, false);
  assert.equal(result.version, "0.4.9");
  assert.match(result.reason, /older than the required 0\.5\.0/);
  assert.match(result.hint, /Update uv to 0\.5\.0/);
  assert.equal(compareVersions("0.4.9", "0.5.0") < 0, true);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9") > 0, true);
  assert.equal(versionOf("uv 0.7.3 (abc)"), "0.7.3");
});

test("resolution is cached and refreshed on demand (R6-06)", async (t) => {
  const host = await fakeHost(t);
  const file = await host.write(host.known, "uv", "#!/bin/sh\necho 'uv 0.7.0'\n");
  const env = { PATH: host.known, HOME: host.root };
  clearHostToolCache();
  const first = await resolveHostTool("uv", { roots: [], env });
  await fs.rm(file);
  const cached = await resolveHostTool("uv", { roots: [], env });
  assert.equal(cached.path, first.path, "the session cache answers without re-searching");
  const refreshed = await resolveHostTool("uv", { roots: [], env, refresh: true });
  assert.equal(refreshed.path, null, "a changed setting or folder refreshes the answer");
});

test("the injected-resolver adapter keeps 0.3.x fixtures working and still reports a miss (R6-35)", async () => {
  const resolve = resolverFrom({ findHostTool: async (name) => (name === "uv" ? "/trusted/uv" : undefined) });
  const found = await resolve("uv", { roots: [] });
  assert.equal(found.path, "/trusted/uv");
  assert.equal(found.verified, true);
  assert.equal(found.version, null, "an injected resolver does not invent a version");
  const missing = await resolverFrom({ findHostTool: async () => undefined })("uv", { roots: [] });
  assert.equal(missing.verified, false);
  assert.equal(resolverFrom({}), resolveHostTool);
});

test("the real interpreter resolves through PATH with a real version probe", async () => {
  clearHostToolCache();
  const result = await resolveHostTool("node", { roots: [], env: process.env });
  assert.equal(result.verified, true, `${node} should resolve on this host`);
  assert.match(String(result.version), /^\d+\.\d+/);
});

/**
 * 0.3.6 audit fixes. The tool name is a fixture name wherever the documented system locations are
 * searched, so a real tool installed on the test host cannot answer the probe.
 */
test("an unset %APPDATA% still produces a verdict instead of aborting the plan (R6-01, T6-02)", async (t) => {
  const host = await fakeHost(t);
  const env = { PATH: host.onPath, USERPROFILE: host.root, LOCALAPPDATA: host.root };
  const list = knownLocations("win32", env);
  assert.ok(list.length >= 5, `${list.length} documented win32 locations survive an unset variable`);
  assert.ok(list.every((entry) => typeof entry === "string" && entry.length > 1), "no undefined entry reaches path.join");
  assert.deepEqual(knownLocations("win32", {}), ["C:\\Program Files\\uv"], "an empty environment yields the one fixed location, not a TypeError");
  clearHostToolCache();
  const result = await resolveHostTool("uv", { platform: "win32", roots: [host.workspace], env });
  assert.equal(result.path, null);
  assert.equal(result.verified, false);
  assert.match(result.reason, /uv was not found\. Searched:/, result.reason);
  assert.match(result.hint, /researchStack\.uvPath/);
});

test("a misconfigured researchStack.uvPath is reported as misconfigured, never as a missing tool (T6-03)", async (t) => {
  const host = await fakeHost(t);
  const real = await host.write(host.known, "uv", "#!/bin/sh\necho 'uv 0.7.3'\n");
  const cases = [
    [`"${real}"`, /wrapped in quotes/],
    [path.join(".local", "uv"), /relative path/],
    [host.known, /directory, not an executable file/],
    [`${real}${path.sep}`, /ends with a path separator/],
    [`${real} `, /leading or trailing spaces/],
  ];
  for (const [value, pattern] of cases) {
    clearHostToolCache();
    const result = await resolveHostTool("uvfixture", { roots: [host.workspace], configuredPath: value, env: { PATH: "", HOME: path.join(host.root, "no-home") } });
    assert.equal(result.verified, false, `${value} is not a usable tool`);
    assert.equal(result.path, null, "a rejected setting is not reported as a found tool");
    assert.equal(result.source, "setting");
    assert.match(result.reason, /was not used: the configured path/, result.reason);
    assert.match(result.reason, pattern, result.reason);
    assert.ok(result.reason.includes(String(value)), `the reason names the configured value: ${result.reason}`);
    assert.ok(!/was not found/.test(result.reason), `the report must not claim the tool is missing: ${result.reason}`);
    assert.match(result.hint, /researchStack\.uvPath/, result.hint);
  }
  assert.equal(settingProblem(real), null, "a well-formed absolute path is not a configuration problem");
});

test("a file that exists but is not executable is reported as found but unusable (T6-01)", async (t) => {
  const host = await fakeHost(t);
  const file = path.join(host.known, "uvfixture");
  await fs.writeFile(file, "#!/bin/sh\necho 'uvfixture 0.7.3'\n");
  await fs.chmod(file, 0o644);
  clearHostToolCache();
  const result = await resolveHostTool("uvfixture", { roots: [host.workspace], env: { PATH: host.known, HOME: path.join(host.root, "no-home") } });
  assert.equal(result.verified, false);
  assert.equal(result.usable, false);
  assert.equal(result.path, await fs.realpath(file), "the file is reported where it was found");
  assert.match(result.reason, /uvfixture was found at .* but it is not executable/, result.reason);
  assert.ok(!/was not found/.test(result.reason), "the tool exists; the report must not claim it is missing");
  assert.match(result.hint, /researchStack\.uvPath/, result.hint);
});

test("a version banner on stderr answers the probe (T6-04)", async (t) => {
  const host = await fakeHost(t);
  const file = await host.write(host.known, "uv", "#!/bin/sh\necho 'uv 0.7.9' 1>&2\n");
  clearHostToolCache();
  const result = await resolveHostTool("uv", { roots: [host.workspace], env: { PATH: host.known, HOME: path.join(host.root, "no-home") }, minimumVersion: "0.5.0" });
  assert.equal(result.path, await fs.realpath(file));
  assert.equal(result.version, "0.7.9", "a build that prints the version on stderr is still verified");
  assert.equal(result.verified, true);
  assert.match(result.versionOutput, /uv 0\.7\.9/);
});

test("a version probe that exceeds the caller's bound is unverified and names the bound (T6-04)", async (t) => {
  const host = await fakeHost(t);
  const file = await host.write(host.known, "uv", "#!/bin/sh\necho 'uv 0.7.3'\nsleep 5\n");
  clearHostToolCache();
  const result = await resolveHostTool("uv", { roots: [host.workspace], env: { PATH: host.known, HOME: path.join(host.root, "no-home") }, versionTimeoutMs: 250 });
  assert.equal(result.path, await fs.realpath(file));
  assert.equal(result.verified, false);
  assert.match(result.reason, /version command failed/, result.reason);
  assert.match(result.verifyError, /250 ms/, "the caller's bound is the bound that was exceeded");
  assert.equal(hosttools.VERSION_TIMEOUT_MS, 8000, "the default bound stays 8 s");
});

test("a uv.cmd wrapper is reported as found but unusable and is never launched (T6-01)", async (t) => {
  const host = await fakeHost(t);
  const wrapper = await host.write(host.onPath, "uv.cmd", "@echo off\r\nuv.exe %*\r\n");
  const launched = [];
  clearHostToolCache();
  const result = await resolveHostTool("uv", {
    platform: "win32",
    roots: [host.workspace],
    env: { PATH: host.onPath, USERPROFILE: path.join(host.root, "no-user"), LOCALAPPDATA: path.join(host.root, "no-local"), HOME: path.join(host.root, "no-home") },
    runProcess: async (executable) => { launched.push(executable); return { stdout: "uv 0.7.3", stderr: "" }; },
  });
  assert.equal(result.verified, false, "a batch wrapper is not a launchable tool");
  assert.equal(result.usable, false);
  assert.equal(launched.length, 0, "shell:false means setup never starts a batch file");
  assert.equal(result.path, await fs.realpath(wrapper), "the wrapper is reported where it was found");
  assert.match(result.reason, /Windows batch wrapper; setup cannot launch it directly — set researchStack\.uvPath to the uv\.exe it calls/, result.reason);
  assert.match(result.hint, /uv\.exe/, result.hint);
});

test("PATH entries are probed once each and the relative ones are counted in the summary (R6-02)", async (t) => {
  const host = await fakeHost(t);
  const env = { PATH: `${host.onPath}${path.delimiter}${host.onPath}${path.delimiter}relative-one${path.delimiter}.${path.delimiter}relative-two`, HOME: path.join(host.root, "no-home") };
  const scan = pathScan(env);
  assert.deepEqual(scan.entries, [host.onPath], "a duplicated PATH entry is probed once");
  assert.equal(scan.duplicates, 1);
  assert.equal(scan.skippedRelative, 3, "relative entries are still refused, and now counted");
  assert.deepEqual(pathEntries({ PATH: `/a${path.delimiter}relative${path.delimiter}/a` }), ["/a"], "the exported helper keeps absolute entries only, without duplicates");
  clearHostToolCache();
  const result = await resolveHostTool("uvfixture", { roots: [host.workspace], env });
  assert.equal(result.searched.pathEntries, 1, "the summary counts the entries actually probed");
  assert.equal(result.searched.pathEntriesSkippedRelative, 3);
  assert.match(result.reason, /1 absolute PATH entr\(ies\), 3 PATH entr\(ies\) skipped as relative/, result.reason);
});


test("a 0-byte uv.exe on a Windows host is found but refused, not offered as a usable tool (0.3.7 Windows review D7)", async (t) => {
  const host = await fakeHost(t);
  const empty = await host.write(host.onPath, "uv.exe", "");
  const launched = [];
  clearHostToolCache();
  const result = await resolveHostTool("uv", {
    platform: "win32",
    roots: [host.workspace],
    env: { PATH: host.onPath, USERPROFILE: path.join(host.root, "no-user"), LOCALAPPDATA: path.join(host.root, "no-local"), HOME: path.join(host.root, "no-home") },
    runProcess: async (executable) => { launched.push(executable); return { stdout: "uv 0.13.6", stderr: "" }; },
  });
  assert.equal(result.usable, false, "Windows has no executable bit, so an empty file is the unusable case");
  assert.equal(result.verified, false);
  assert.equal(launched.length, 0, "an empty file is never spawned");
  assert.equal(result.path, await fs.realpath(empty), "it is still reported where it was found");
  assert.match(result.reason, /uv was found at .*uv\.exe but it is an empty file/, result.reason);
  assert.match(result.hint, /uv/, "the operator still gets the setting that can fix it");
});

/**
 * 0.3.7 e2e review D10. The 0-byte check above was limited to win32. On a POSIX host the
 * executable bit can be set on an empty file: it spawns, exits 0 and prints nothing, and 0.3.7
 * reported it as a usable tool whose version was missing — receipts/15b and receipts/16b show
 * `usable: true`, "did not report a version" and the hint "Update uv and retry" for a file that
 * contains nothing. A 0-byte file is not a tool on any platform.
 */
test("a 0-byte executable uv on a POSIX host is refused as what it is, and never spawned (e2e D10)", async (t) => {
  const host = await fakeHost(t);
  for (const platform of ["linux", "darwin"]) {
    const empty = path.join(host.known, "uv");
    await fs.writeFile(empty, "");
    await fs.chmod(empty, 0o755);
    const launched = [];
    clearHostToolCache();
    const result = await resolveHostTool("uv", {
      platform,
      roots: [host.workspace],
      env: { PATH: "", HOME: host.root },
      runProcess: async (executable) => { launched.push(executable); return { stdout: "", stderr: "" }; },
    });
    assert.equal(result.usable, false, `${platform}: a 0-byte file is not a tool`);
    assert.equal(result.verified, false, `${platform}: nothing ran to verify`);
    assert.equal(result.version, null, `${platform}: no version is invented`);
    assert.equal(launched.length, 0, `${platform}: the empty file is never spawned`);
    assert.equal(result.path, await fs.realpath(empty), `${platform}: it is reported where it was found`);
    assert.match(result.reason, /uv was found at .*\/uv but it is an empty file \(0 bytes\), which cannot be a tool/, result.reason);
    assert.ok(!/did not report a version/.test(result.reason), `the diagnosis must not blame the version probe: ${result.reason}`);
    assert.ok(!/Update uv and retry/.test(result.hint), `the hint must not tell the operator to update uv: ${result.hint}`);
    assert.match(result.hint, /Replace .*\/uv with a working uv executable, or set researchStack\.uvPath to the uv executable you intend setup to run\./, result.hint);
    assert.ok(!/was not found/.test(result.reason), `the file exists; the report must not claim it is missing: ${result.reason}`);
  }
});

test("a 0-byte file in an earlier location does not stop the search from finding a working uv (e2e D10)", async (t) => {
  const host = await fakeHost(t);
  const broken = path.join(host.root, "broken-bin");
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, "uv"), "");
  await fs.chmod(path.join(broken, "uv"), 0o755);
  const working = await host.write(host.onPath, "uv", "#!/bin/sh\necho 'uv 0.13.6'\n");
  const launched = [];
  clearHostToolCache();
  const result = await resolveHostTool("uv", {
    platform: "linux",
    roots: [host.workspace],
    env: { PATH: `${broken}${path.delimiter}${host.onPath}`, HOME: path.join(host.root, "no-home") },
    runProcess: async (executable) => { launched.push(executable); return { stdout: "uv 0.13.6", stderr: "" }; },
  });
  assert.equal(result.path, await fs.realpath(working), "the refusal is not the end of the search");
  assert.equal(result.version, "0.13.6");
  assert.equal(result.verified, true);
  assert.deepEqual(launched, [await fs.realpath(working)], "only the working tool is spawned");
});

/**
 * Confirmed while fixing D10, unchanged by it: a directory is refused on a POSIX host too, and an
 * unusable candidate never masks a usable one later in the search.
 */
test("a directory in a searched location is refused on a POSIX host and does not mask a usable tool (confirmed)", async (t) => {
  const host = await fakeHost(t);
  await fs.mkdir(path.join(host.known, "uv"), { recursive: true });
  const working = await host.write(host.onPath, "uv", "#!/bin/sh\necho 'uv 0.13.6'\n");
  clearHostToolCache();
  const masked = await resolveHostTool("uv", { roots: [host.workspace], env: { PATH: `${host.known}${path.delimiter}${host.onPath}`, HOME: path.join(host.root, "no-home") } });
  assert.equal(masked.path, await fs.realpath(working), "the directory is recorded, the search continues");
  assert.equal(masked.verified, true);
  clearHostToolCache();
  const alone = await resolveHostTool("uv", { roots: [host.workspace], env: { PATH: host.known, HOME: path.join(host.root, "no-home") } });
  assert.equal(alone.usable, false);
  assert.equal(alone.path, await fs.realpath(path.join(host.known, "uv")));
  assert.match(alone.reason, /uv was found at .* but it is a directory, not an executable file/, alone.reason);
});

/**
 * Confirmed while fixing D10: the version probe does not accept a clean exit as a version.
 * A 0-byte file no longer reaches this branch at all.
 */
test("a tool that exits 0 and prints nothing is not a usable version (confirmed)", async (t) => {
  const host = await fakeHost(t);
  const file = await host.write(host.known, "uv", "#!/bin/sh\nexit 0\n");
  clearHostToolCache();
  const result = await resolveHostTool("uv", { roots: [host.workspace], env: { PATH: host.known, HOME: path.join(host.root, "no-home") } });
  assert.equal(result.version, null, "empty stdout is not a version");
  assert.equal(result.verified, false, "exit 0 with no output is not a verified tool");
  assert.equal(result.usable, true, "a non-empty executable is launchable; only its version is unproven");
  assert.match(result.reason, /uv at .* did not report a version\./, result.reason);
});

/**
 * Windows portability review W1. `probeCandidate` answers with the realpath of the candidate while
 * the workspace roots were compared unresolved, so a workspace handed over through a link — a
 * symlink here, a junction or a mapped drive on Windows — hid a workspace-local tool from the
 * refusal and it was spawned.
 */
test("a workspace-local tool reached through a link at the workspace root is refused (Windows review W1)", async (t) => {
  if (process.platform === "win32") return t.skip("needs a POSIX symlink; the junction variant is measured on the Windows host");
  const host = await fakeHost(t);
  const bin = path.join(host.workspace, ".venv", "bin");
  await fs.mkdir(bin, { recursive: true });
  const inside = await host.write(bin, "uv", "#!/bin/sh\necho 'uv 0.13.6'\n");
  const link = path.join(host.root, "link-to-workspace");
  await fs.symlink(host.workspace, link, "dir");
  const resolvedInside = await fs.realpath(inside);

  const launched = [];
  clearHostToolCache();
  const throughLink = await resolveHostTool("uv", {
    roots: [link],
    configuredPath: path.join(link, ".venv", "bin", "uv"),
    env: { PATH: "", HOME: path.join(host.root, "no-home") },
    runProcess: async (executable) => { launched.push(executable); return { stdout: "uv 0.13.6", stderr: "" }; },
  });
  assert.equal(throughLink.path, null, "the root is resolved the same way the candidate is");
  assert.deepEqual(throughLink.workspaceRefusals, [resolvedInside]);
  assert.equal(launched.length, 0, "a workspace-local tool is never spawned");
  assert.match(throughLink.reason, /1 candidate\(s\) inside the workspace were refused/, throughLink.reason);

  clearHostToolCache();
  const viaPath = await resolveHostTool("uv", {
    roots: [link],
    env: { PATH: bin, HOME: path.join(host.root, "no-home") },
    runProcess: async (executable) => { launched.push(executable); return { stdout: "uv 0.13.6", stderr: "" }; },
  });
  assert.equal(viaPath.path, null, "the same refusal applies to a tool found through PATH");
  assert.deepEqual(viaPath.workspaceRefusals, [resolvedInside]);

  clearHostToolCache();
  const control = await resolveHostTool("uv", { roots: [host.workspace], configuredPath: inside, env: { PATH: "", HOME: path.join(host.root, "no-home") } });
  assert.deepEqual(control.workspaceRefusals, [resolvedInside], "the refusal wording is the one 0.3.7 already had for a resolved root");
});

/**
 * Windows portability review W13. Some installers write a PATH entry with surrounding quotes;
 * quoted, the entry was joined into a candidate path that realpath could not resolve, so the
 * folder was skipped without being counted. And on Windows the same folder is routinely spelled
 * two ways, which the case-sensitive dedupe probed twice.
 */
test("PATH entries are de-quoted, and on Windows the same folder spelled two ways is probed once (Windows review W13)", async (t) => {
  const host = await fakeHost(t);
  const file = await host.write(host.onPath, "uvfixture", "#!/bin/sh\necho 'uvfixture 1.2.3'\n");
  clearHostToolCache();
  const quoted = await resolveHostTool("uvfixture", { roots: [host.workspace], env: { PATH: `"${host.onPath}"`, HOME: path.join(host.root, "no-home") } });
  assert.equal(quoted.path, await fs.realpath(file), "a quoted PATH entry names a folder the operator meant to search");
  assert.equal(quoted.version, "1.2.3");
  assert.equal(quoted.searched.pathEntries, 1, "the entry is counted as searched, not silently skipped");

  const scan = pathScan({ PATH: `"${host.onPath}"${path.delimiter}'${host.onPath}'` });
  assert.deepEqual(scan.entries, [host.onPath], "surrounding quotes are removed before the entry is used");
  assert.equal(scan.duplicates, 1);
  assert.equal(pathScan({ PATH: `""${path.delimiter}.` }).skippedRelative, 2, "an entry that is only quotes is refused as a relative entry, and counted");

  const win = pathScan({ PATH: "/tmp/A/Bin:/tmp/a/bin" }, "win32");
  assert.deepEqual(win.entries, ["/tmp/A/Bin"], "on Windows C:\\Windows and c:\\windows are the same folder, probed once");
  assert.equal(win.duplicates, 1);
  const posix = pathScan({ PATH: "/tmp/A/Bin:/tmp/a/bin" }, "linux");
  assert.deepEqual(posix.entries, ["/tmp/A/Bin", "/tmp/a/bin"], "on a case-sensitive host they are two folders");
  assert.equal(posix.duplicates, 0);
});

/**
 * Windows portability review W18. The win32 list was built with the host's `path.join`, so on a
 * POSIX host it mixed `/` and `\` and every entry was rejected by `path.isAbsolute` — the branch
 * could not be asserted on this host. The list is now built with the separators of the platform
 * argument, whatever machine builds it.
 */
test("the win32 documented-location list uses Windows separators whatever host builds it (Windows review W18)", () => {
  const env = { USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", APPDATA: "C:\\Users\\u\\AppData\\Roaming", HOME: "/home/u" };
  const list = knownLocations("win32", env);
  assert.equal(list.length, 7, "the documented win32 list is unchanged in content");
  for (const entry of list) {
    assert.ok(path.win32.isAbsolute(entry), `a win32 location must be win32-absolute: ${entry}`);
    assert.ok(!entry.includes("/"), `no mixed separators: ${entry}`);
    assert.equal(path.win32.normalize(entry), entry, `already in Windows form: ${entry}`);
  }
  assert.ok(list.includes("C:\\Program Files\\uv"), "the fixed location is still there");
  const fromPosixSpelling = knownLocations("win32", { USERPROFILE: "/home/u" });
  assert.ok(fromPosixSpelling.every((entry) => !entry.includes("/")), `the win32 list never mixes separators: ${JSON.stringify(fromPosixSpelling)}`);
  const posix = knownLocations("linux", { HOME: "/home/u", XDG_BIN_HOME: "" });
  assert.ok(posix.every((entry) => path.posix.isAbsolute(entry) && !entry.includes("\\")), `the POSIX list stays POSIX: ${JSON.stringify(posix)}`);
});

/**
 * 0.3.7 e2e review D9. `npm run verify-package` in a shell without uv on PATH died with
 * `Error: spawnSync uv ENOENT` and a Node stack trace. The gate is real and does need uv; the
 * failure has to read as an instruction, and has to name the setting the extension itself uses so
 * the operator does not confuse the two lookups.
 */
test("the release gate names the missing uv instead of throwing a stack trace (e2e D9)", async (t) => {
  const extensionRoot = path.resolve(__dirname, "..");
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, "vsix-manifest.json"), "utf8"));
  const artifact = path.join(extensionRoot, "..", "dist", `research-stack-toolkit-${manifest.version}.vsix`);
  try { await fs.access(artifact); } catch { return t.skip(`the gate audits the packaged artifact, which is not built here: ${artifact}`); }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-gate-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const gate = ["scripts/with-artifact.js", "uv", "run", "--locked", "python", "../scripts/verify_vsix.py"];

  const missing = spawnSync(process.execPath, gate, { cwd: extensionRoot, encoding: "utf8", env: { PATH: "" } });
  assert.equal(missing.status, 1, "the gate fails, it does not crash");
  assert.match(missing.stderr, /uv was not found on PATH/, missing.stderr);
  assert.match(missing.stderr, /Command attempted: uv run --locked python \.\.\/scripts\/verify_vsix\.py .*research-stack-toolkit-.*\.vsix/, missing.stderr);
  assert.match(missing.stderr, /researchStack\.uvPath/, "the operator is told which setting the extension uses");
  assert.match(missing.stderr, /export PATH=/, "the operator is told what to change", missing.stderr);
  assert.ok(!/spawnSync uv ENOENT/.test(missing.stderr), `no raw spawn error: ${missing.stderr}`);
  assert.ok(!/at (Object|Module|node:)/.test(missing.stderr), `no stack trace: ${missing.stderr}`);
  assert.ok(!/Node\.js v\d/.test(missing.stderr), `no Node version banner: ${missing.stderr}`);

  if (process.platform !== "win32") {
    const shim = path.join(scratch, "uv");
    await fs.writeFile(shim, "#!/bin/sh\necho \"shim argv: $*\"\nexit 3\n");
    await fs.chmod(shim, 0o755);
    const present = spawnSync(process.execPath, gate, { cwd: extensionRoot, encoding: "utf8", env: { PATH: scratch } });
    assert.equal(present.status, 3, "with uv on PATH the command's own exit status is still the gate's status");
    assert.ok(present.stdout.includes(artifact), `the artifact is still appended: ${present.stdout}`);
    assert.ok(!/was not found on PATH/.test(present.stderr), `no instruction text when uv is present: ${present.stderr}`);
  }
});
