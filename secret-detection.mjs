/**
 * Lightweight secret detection for durable goal state.
 * Kept in plain JS so we can test with Node's built-in test runner without extra tooling.
 */

/** @typedef {{ name: string, regex: RegExp }} NamedPattern */

/** @type {NamedPattern[]} */
export const SECRET_PATTERNS = [
	{ name: "Private key block", regex: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP|PRIVATE) PRIVATE KEY-----/i },
	{ name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "GitHub personal access token", regex: /\bghp_[A-Za-z0-9]{36,}\b/ },
	{ name: "Generic API key assignment", regex: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["'][^"'\n]{8,}["']/i },
	{ name: "JWT token", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/ },
];

/**
 * @param {string} text
 * @param {NamedPattern[]} patterns
 * @returns {NamedPattern | undefined}
 */
export function firstMatch(text, patterns) {
	return patterns.find((p) => p.regex.test(text));
}

/**
 * @param {string} content
 * @returns {string | undefined}
 */
export function detectSecret(content) {
	return firstMatch(content, SECRET_PATTERNS)?.name;
}
