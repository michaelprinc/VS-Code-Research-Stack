"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const registry = require("../components.json");
const root = path.resolve(__dirname, "..");

test("every catalog component has a modular guide and a generated hub entry", () => {
  const ids = new Set(registry.components.map((item) => item.id));
  assert.equal(ids.size, registry.components.length);
  for (const profile of ["basic", "recommended", "full"]) {
    const components = JSON.parse(fs.readFileSync(path.join(root, "..", "catalog", `${profile}-components.json`), "utf8")).components;
    for (const item of components) assert.ok(ids.has(item.id), `Missing guide: ${item.id}`);
  }
  const index = fs.readFileSync(path.join(root, "guides", "index.md"), "utf8");
  for (const item of registry.components) {
    assert.equal(item.guide, `guides/${item.id}.md`);
    const guide = fs.readFileSync(path.join(root, item.guide), "utf8");
    for (const heading of ["## Setup", "## First task and readiness", "## Troubleshooting and limits", "## Current documentation"]) assert.ok(guide.includes(heading), `${item.id}: ${heading}`);
    assert.ok(index.includes(`(${item.id}.md)`));
    if (item.officialUrl) { assert.equal(new URL(item.officialUrl).protocol, "https:"); assert.ok(guide.includes(item.officialUrl)); }
  }
});

test("offline guide links resolve within the packaged extension", () => {
  for (const file of fs.readdirSync(path.join(root, "guides"))) {
    const text = fs.readFileSync(path.join(root, "guides", file), "utf8");
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https:\/\//.test(match[1])) continue;
      const destination = path.resolve(root, "guides", match[1]);
      assert.ok(destination.startsWith(root + path.sep));
      assert.ok(fs.existsSync(destination), `${file}: ${match[1]}`);
    }
  }
});
