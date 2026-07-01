export function normalizeGoal<T extends Record<string, unknown>>(goal: T): T;
export function nextCriterionId(existing?: Array<{ id: string }>): string;
export function normalizeCriteriaInputs(inputs: unknown[], existing?: Array<{ id: string }>): unknown[];
export function applyCriterionUpdates(criteria: unknown[], updates: unknown[]): unknown[];
export function validateReview(review: unknown): void;
export function completionReadiness(goal: unknown): { ready: boolean; missing: string[] };
