import test from "node:test";
import assert from "node:assert/strict";

import { detectSecret } from "../secret-detection.mjs";

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

for (const prefix of ["", "ENCRYPTED ", "RSA ", "EC ", "OPENSSH ", "DSA ", "PGP "]) {
	test(`detectSecret finds ${prefix || "standard "}private key header`, () => {
		assert.equal(detectSecret("-----BEGIN " + prefix + "PRIVATE KEY-----"), "Private key block");
	});
}
