import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

test("host packages are peers, never runtime dependencies or bundles", () => {
  for (const name of hostPackages) {
    assert.equal(manifest.dependencies?.[name], undefined, name);
    for (const field of ["bundleDependencies", "bundledDependencies"]) {
      assert.notEqual(manifest[field], true, field);
      assert.ok(!(manifest[field] || []).includes(name), name);
    }
  }
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
    assert.equal(manifest.peerDependencies[name], "*", name);
    assert.equal(manifest.devDependencies[name], name === "typebox" ? "^1.3.19" : "0.99.1", name);
  }
});

test("lockfile matches manifest and pins local Pi validation versions", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    assert.deepEqual(lock.packages[""][field], manifest[field]);
  }
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.equal(lock.packages[`node_modules/${name}`].version, "0.99.1");
  }
});

test("runtime dependencies and explicit extension entry points are preserved", () => {
  assert.deepEqual(manifest.dependencies, { defuddle: "^0.19.3", linkedom: "^0.18.13" });
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, [
    "./show-system-prompt.ts",
    "./web-tools.ts",
    "./subagents.ts",
    "./openai-codex-image-gen.ts",
    "./goal.ts",
  ]);
});
