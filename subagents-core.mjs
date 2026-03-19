/**
 * Shared pure helpers for subagent orchestration.
 * Plain JS to keep unit testing simple with node --test.
 */

/**
 * @typedef {"once" | "loop"} LoopMode
 * @typedef {"min" | "max"} Objective
 */

/**
 * @param {string} output
 * @param {string} metricRegex Regex string with at least one capture group for the metric value
 * @returns {number | undefined}
 */
export function parseMetric(output, metricRegex) {
	try {
		const re = new RegExp(metricRegex, "m");
		const match = output.match(re);
		if (!match || !match[1]) return undefined;
		const value = Number(match[1]);
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {Objective} objective
 * @param {number} current
 * @param {number | undefined} best
 * @returns {boolean}
 */
export function improved(objective, current, best) {
	if (best === undefined) return true;
	return objective === "min" ? current < best : current > best;
}

/**
 * @param {{ maxIterations?: number, maxDurationMinutes?: number, maxNoImprove?: number, targetMetric?: number }} params
 * @returns {boolean}
 */
export function hasLoopGuard(params) {
	return Boolean(
		params.maxIterations ||
			params.maxDurationMinutes ||
			params.maxNoImprove ||
			params.targetMetric !== undefined,
	);
}

/**
 * @param {LoopMode} mode
 * @param {{ maxIterations?: number, maxDurationMinutes?: number, maxNoImprove?: number, targetMetric?: number }} params
 * @returns {string | undefined} error message when invalid
 */
export function validateLoopConfig(mode, params) {
	if (mode !== "loop") return undefined;
	if (hasLoopGuard(params)) return undefined;
	return "Loop mode requires at least one stop condition (maxIterations, maxDurationMinutes, maxNoImprove, or targetMetric).";
}
