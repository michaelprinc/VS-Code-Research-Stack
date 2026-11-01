"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
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

