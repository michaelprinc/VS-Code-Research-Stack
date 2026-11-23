"use strict";
/**
 * Link fixtures that state what they could actually be built with (0.3.15, P1 / T16-10).
 *
 * The 19 November 2026 run on the reference Windows host had 68 of 73 Node tests pass. Four of the
 * five failures were not the Toolkit refusing something: they were the *fixture* failing, with
 * `EPERM` while creating a symbolic link. Windows allows an unprivileged process to create a NTFS
 * junction but not a symbolic link — symbolic links need `SeCreateSymbolicLinkPrivilege`, which a
 * plain shell does not hold unless Developer Mode is on. A test that needs a link therefore has to
 * say which link it built, and must not report "the refusal works" for a refusal it never got to
 * exercise.
 *
 * Two rules follow, and this module is the only place either of them is decided:
 *  - a **directory** fixture uses a junction on Windows, which needs no privilege and is what those
 *    tests have always meant to put in the way of the Toolkit;
 *  - a **file** fixture is attempted as a real link, and where the host refuses to make one the test
 *    is skipped *with the reason recorded* — the link-refusal coverage stays real on a host that can
 *    build the fixture, and the Windows receipt records the gap instead of a fake pass.
 *
 * The recorded gap is not cosmetic: a junction is a reparse point that `lstat().isSymbolicLink()`
 * does not report, so the file-link scenarios are exactly the ones a junction attack would use, and
 * they remain unproven until a host that can create a file link runs them.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const IS_WINDOWS = process.platform === "win32";

// Probed once per process, in a scratch directory, so a skipped test reports a host capability
// rather than an unrelated failure of the code under test.
let fileLinkCapability = null;
function canCreateFileLinks() {
  if (fileLinkCapability !== null) return fileLinkCapability;
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "research-link-probe-"));
  try {
    const target = path.join(probe, "target.txt");
    fs.writeFileSync(target, "probe");
    fs.symlinkSync(target, path.join(probe, "link.txt"), "file");
    fileLinkCapability = { ok: true, reason: "" };
  } catch (error) {
    fileLinkCapability = { ok: false, reason: `${error.code || error.name}: ${error.message}` };
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
  return fileLinkCapability;
}

/**
 * Put a directory link (junction on Windows) at `linkPath` pointing at `target`. Always works on both
 * platforms. Returns the kind of link the host accepted, because a test that asserts the Toolkit
 * treated it as a link should know which reparse point it handed over.
 */
function directoryLink(target, linkPath) {
  const kind = IS_WINDOWS ? "junction" : "dir";
  fs.symlinkSync(target, linkPath, kind);
  return kind;
}

/**
 * Put a file link at `linkPath`. Returns `true` when the link exists. When the host will not create
 * one, it records the reason on the test and returns `false` — the caller stops there rather than
 * asserting a refusal it was never given the chance to test.
 */
function fileLink(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EEXIST") throw error;
    const capability = canCreateFileLinks();
    t.skip(`link fixture not creatable on ${process.platform}: ${capability.reason || `${error.code}: ${error.message}`}. `
      + "The link-refusal assertion runs on a host that can create the link (Windows with Developer Mode, or POSIX).");
    return false;
  }
}

/** Why a link test was skipped, for the host receipt. */
function linkCapability() {
  return {
    platform: process.platform,
    fileLinks: canCreateFileLinks(),
    directoryLinks: { ok: true, reason: IS_WINDOWS ? "junction (no privilege required)" : "symlink" },
  };
}

module.exports = { canCreateFileLinks, directoryLink, fileLink, linkCapability, IS_WINDOWS };
