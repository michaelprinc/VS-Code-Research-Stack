"use strict";
/**
 * The reference-host runner's own decisions (0.3.15, P1 / T16-01 / T16-10).
 *
 * `run-host-test.js` is the only thing that puts the Toolkit in a real Extension Host, so the two
 * claims it has to get right are separable and both are testable without a host: which code the run
 * exercised, and that the run cannot touch a profile outside the disposable root. A real VS Code run
 * still has to happen on the reference Windows host — nothing here stands for it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { planRun, readCandidateIdentity, digestFile } = require("./run-host-test");

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-host-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the runner names the executable and a disposable root or refuses", () => {
  assert.throws(() => planRun({}), /VSCODE_EXECUTABLE_PATH/);
  assert.throws(() => planRun({ VSCODE_EXECUTABLE_PATH: "/vscode" }), /VSCODE_TEST_ROOT/);
});

test("a source-tree run says so, and the default target is the extension directory", (t) => {
  const root = scratch(t);
  const plan = planRun({ VSCODE_EXECUTABLE_PATH: "/vscode", VSCODE_TEST_ROOT: root });
  assert.equal(plan.mode, "source-tree-default");
  assert.equal(plan.target, path.resolve(__dirname, ".."));
  assert.ok(plan.launchArgs.some((argument) => argument.startsWith("--user-data-dir=")));
  assert.ok(plan.launchArgs.some((argument) => argument.startsWith("--extensions-dir=")));
});

test("an explicit development path is reported as the source tree, not as a candidate", (t) => {
  const root = scratch(t);
  const source = path.join(root, "src-tree");
  fs.mkdirSync(source);
  const plan = planRun({ VSCODE_EXECUTABLE_PATH: "/vscode", VSCODE_TEST_ROOT: root, EXTENSION_DEVELOPMENT_PATH: source });
  assert.equal(plan.mode, "source-tree");
  assert.equal(plan.target, source);
});

test("a candidate VSIX and a development path cannot both be claimed", (t) => {
  const root = scratch(t);
  const vsix = path.join(root, "candidate.vsix");
  fs.writeFileSync(vsix, "zip");
  assert.throws(() => planRun({
    VSCODE_EXECUTABLE_PATH: "/vscode", VSCODE_TEST_ROOT: root,
    EXTENSION_DEVELOPMENT_PATH: root, VSCODE_TEST_VSIX: vsix,
  }), /mutually exclusive/);
});

test("the disposable root is checked in both directions", (t) => {
  const root = scratch(t);
  const plan = planRun({ VSCODE_EXECUTABLE_PATH: "/vscode", VSCODE_TEST_ROOT: root });
  // The profiles the host writes into are inside the root: that is what keeps the operator's own
  // profile out of the run.
  for (const directory of [plan.userData, plan.extensionsDir]) {
    const relative = path.relative(path.resolve(root), directory);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${directory} is outside ${root}`);
  }
  // The root must not sit where the run is measured: inside the extension tree, inside the repository,
  // or inside the managed toolkit folder the extension writes.
  for (const inside of [path.resolve(__dirname, ".."), path.resolve(__dirname, "..", ".."), path.join(process.cwd(), ".research-toolkit", "probe")]) {
    assert.throws(() => planRun({ VSCODE_EXECUTABLE_PATH: "/vscode", VSCODE_TEST_ROOT: inside }), /must not be inside/);
  }
});

test("a candidate is identified by its digest and its member count, not by a filename", (t) => {
  const root = scratch(t);
  const vsix = path.join(root, "research-stack-toolkit-0.3.15.vsix");
  // A minimal but real zip: one local member and its central-directory record, enough for the reader
  // to list members without unpacking or executing anything.
  const name = Buffer.from("extension/package.json", "utf8");
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt32LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(0, 18);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 14);
  central.writeUInt32LE(0, 18);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt16LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  fs.writeFileSync(vsix, Buffer.concat([local, central, end]));

  const plan = planRun({ VSCODE_EXECUTABLE_PATH: "/vscode", VSCODE_TEST_ROOT: root, VSCODE_TEST_VSIX: vsix });
  assert.equal(plan.mode, "installed-candidate");
  assert.equal(plan.target, vsix);
  const identity = readCandidateIdentity(vsix);
  assert.equal(identity.members, 1);
  assert.equal(identity.manifestMember, "extension/package.json");
  assert.equal(digestFile(vsix).length, 64);
});

test("an archive whose declared member count and parsed member count disagree is refused", (t) => {
  const root = scratch(t);
  const vsix = path.join(root, "half-a-candidate.vsix");
  const name = Buffer.from("extension/package.json", "utf8");
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  // The archive claims two members and carries one. A receipt built from this would name an artifact
  // that is not the artifact, which is the failure the reader exists to prevent.
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt16LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  fs.writeFileSync(vsix, Buffer.concat([local, central, end]));
  assert.throws(() => readCandidateIdentity(vsix), /cannot be identified/);
});

test("a candidate path that does not exist is refused before any host is launched", (t) => {
  const root = scratch(t);
  assert.throws(() => planRun({ VSCODE_EXECUTABLE_PATH: "/vscode", VSCODE_TEST_ROOT: root, VSCODE_TEST_VSIX: path.join(root, "missing.vsix") }), /does not exist/);
});
