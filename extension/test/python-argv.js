"use strict";
/**
 * The reviewed Python child shape, read from the shipped runner instead of a hard-coded index.
 *
 * 0.3.8: every Python child the extension starts is `[...PYTHON_FLAGS, …]`, and `PYTHON_FLAGS` is
 * `["-I", "-B", "-X", "utf8"]` — `-X utf8` because a Windows child inherits the console code page
 * and `-I` makes `PYTHONIOENCODING` inert (the 0.3.7 Czech-workspace failure). Fixtures that
 * dispatch on `args[2]` or `args.slice(0, 3).join(" ")` stop matching when the flags grow, and then
 * answer a Python call with the uv or reading-check branch instead of failing. These helpers let a
 * fixture assert the flags are present, in order, and read the command from after them.
 */
const { PYTHON_FLAGS } = require("../runner");

/** The argv a reviewed Python child must be started with. */
function pythonArgv(...tail) {
  return [...PYTHON_FLAGS, ...tail];
}

/** True when `args` begins with exactly the shipped flags, in the shipped order. */
function hasPythonFlags(args) {
  return Array.isArray(args) && args.length > PYTHON_FLAGS.length
    && PYTHON_FLAGS.every((flag, index) => args[index] === flag);
}

/** The arguments after the reviewed flags; empty when the flags are not there. */
function afterPythonFlags(args) {
  return hasPythonFlags(args) ? args.slice(PYTHON_FLAGS.length) : [];
}

/** True for `[...PYTHON_FLAGS, kind, …]` — the `-c` and `-m` forms. */
function isPythonCall(args, kind) {
  return hasPythonFlags(args) && args[PYTHON_FLAGS.length] === kind;
}

/** True for `[...PYTHON_FLAGS, <path ending in suffix>, …]` — probe.py and functional_check.py. */
function runsPythonFile(args, suffix) {
  return hasPythonFlags(args) && String(args[PYTHON_FLAGS.length] || "").endsWith(suffix);
}

module.exports = { PYTHON_FLAGS, pythonArgv, hasPythonFlags, afterPythonFlags, isPythonCall, runsPythonFile };
