import test from "node:test";
import assert from "node:assert/strict";

import { hasLoopGuard, improved, parseMetric, validateLoopConfig } from "../subagents-core.mjs";

test("parseMetric extracts first capture group as number", () => {
	const output = "val_bpb: 0.997900\npeak_vram_mb: 45060.2\n";
	assert.equal(parseMetric(output, "^val_bpb:\\s*([0-9.]+)"), 0.9979);
});

test("parseMetric returns undefined for invalid regex", () => {
	const output = "val_bpb: 0.997900\n";
	assert.equal(parseMetric(output, "^val_bpb:(["), undefined);
});

test("improved handles min and max objectives", () => {
	assert.equal(improved("min", 0.9, 1.0), true);
	assert.equal(improved("min", 1.0, 0.9), false);
	assert.equal(improved("max", 2.0, 1.0), true);
	assert.equal(improved("max", 1.0, 2.0), false);
	assert.equal(improved("min", 1.0, undefined), true);
});

test("hasLoopGuard detects explicit loop stop conditions", () => {
	assert.equal(hasLoopGuard({}), false);
	assert.equal(hasLoopGuard({ maxIterations: 10 }), true);
	assert.equal(hasLoopGuard({ maxDurationMinutes: 60 }), true);
	assert.equal(hasLoopGuard({ maxNoImprove: 5 }), true);
	assert.equal(hasLoopGuard({ targetMetric: 0.9 }), true);
});

test("validateLoopConfig requires stop conditions only in loop mode", () => {
	assert.equal(validateLoopConfig("once", {}), undefined);
	assert.match(validateLoopConfig("loop", {}) ?? "", /requires at least one stop condition/i);
	assert.equal(validateLoopConfig("loop", { maxIterations: 1 }), undefined);
});
