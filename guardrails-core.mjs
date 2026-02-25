/**
 * Shared detection logic for guardrails extension.
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

/** @type {NamedPattern[]} */
export const DANGEROUS_BASH_PATTERNS = [
	{ name: "rm -rf", regex: /\brm\b[^\n]*\s-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)/i },
	{ name: "Disk formatting (mkfs)", regex: /\bmkfs(?:\.[a-z0-9_+-]+)?\b/i },
	{ name: "Raw disk overwrite (dd ... of=/dev/*)", regex: /\bdd\b[^\n]*\bof=\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|disk\d+s\d+|rdisk\d+s\d+)\b/i },
	{ name: "Destructive git clean", regex: /\bgit\s+clean\s+-[^\n]*f[^\n]*d/i },
	{ name: "Hard reset", regex: /\bgit\s+reset\s+--hard\b/i },
	{ name: "Shutdown/reboot", regex: /\b(?:shutdown|reboot|halt|poweroff)\b/i },
	{ name: "Fork bomb", regex: /:\(\)\s*\{\s*:\|:\s*&\s*\};\s*:/ },
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
 * @param {unknown} value
 * @returns {string}
 */
export function getString(value) {
	return typeof value === "string" ? value : "";
}

/**
 * @param {string} content
 * @returns {string | undefined}
 */
export function detectSecret(content) {
	return firstMatch(content, SECRET_PATTERNS)?.name;
}

/**
 * @param {string} command
 * @returns {string | undefined}
 */
export function detectDangerousCommand(command) {
	return firstMatch(command, DANGEROUS_BASH_PATTERNS)?.name;
}
