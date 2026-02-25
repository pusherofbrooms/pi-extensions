import test from "node:test";
import assert from "node:assert/strict";

import { detectDangerousCommand, detectSecret } from "../guardrails-core.mjs";

test("detectSecret finds private key material", () => {
	const begin = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
	const end = "-----END " + "OPENSSH PRIVATE KEY-----";
	const content = `${begin}\nabc\n${end}`;
	assert.equal(detectSecret(content), "Private key block");
});

test("detectSecret finds API key assignment", () => {
	const left = "api_" + "key";
	const content = `const ${left} = \"supersecretvalue123\";`;
	assert.equal(detectSecret(content), "Generic API key assignment");
});

test("detectSecret ignores normal content", () => {
	const content = "export const answer = 42;";
	assert.equal(detectSecret(content), undefined);
});

test("detectDangerousCommand flags rm -rf", () => {
	assert.equal(detectDangerousCommand("rm -rf /tmp/safe-test"), "rm -rf");
});

test("detectDangerousCommand flags destructive git clean", () => {
	assert.equal(detectDangerousCommand("git clean -fd"), "Destructive git clean");
});

test("detectDangerousCommand ignores common safe command", () => {
	assert.equal(detectDangerousCommand("ls -la"), undefined);
});
