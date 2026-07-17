import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GoalScaffold, ScaffoldPolicy } from "./goal-types.ts";

export type ScaffoldDirectories = { bundled: string; user: string; project: string };

export const FALLBACK_DEFAULT_SCAFFOLD: GoalScaffold = {
  id: "default", name: "Default", description: "Generic coherent progress for ordinary goals.",
  body: "Complete one coherent, bounded unit of progress, record evidence, and stop.", source: "bundled",
  policy: { goalShape: "general", workflow: "worker", completionPolicy: "parent-review", blockedPolicy: "external-blocker-only", waitingAllowed: false, mergePolicy: "evidence-first" },
};

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) data[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
  }
  return { data, body: raw.slice(end + 5).trim() };
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["true", "yes", "1"].includes(value.toLowerCase())) return true;
  if (["false", "no", "0"].includes(value.toLowerCase())) return false;
  return undefined;
}

function parseScaffoldPolicy(data: Record<string, string>): ScaffoldPolicy {
  return { goalShape: data.goalShape, workflow: data.workflow, reviewEvery: parsePositiveInt(data.reviewEvery), completionPolicy: data.completionPolicy, blockedPolicy: data.blockedPolicy, waitingAllowed: parseBoolean(data.waitingAllowed), mergePolicy: data.mergePolicy };
}

export function scaffoldPolicyText(scaffold: GoalScaffold): string {
  const entries = Object.entries(scaffold.policy).filter(([, value]) => value !== undefined && value !== "");
  return entries.length ? entries.map(([key, value]) => `- ${key}: ${value}`).join("\n") : "- No explicit policy.";
}

async function readScaffoldFile(baseDir: string, id: string, source: GoalScaffold["source"]): Promise<GoalScaffold | undefined> {
  const path = join(baseDir, id, "SCAFFOLD.md");
  if (!existsSync(path)) return undefined;
  const { data, body } = parseFrontmatter(await readFile(path, "utf8"));
  return { id: data.name ?? id, name: data.title ?? data.name ?? id, description: data.description ?? "Custom goal scaffold.", body, source, path, policy: parseScaffoldPolicy(data) };
}

async function listScaffoldsFromDir(baseDir: string, source: GoalScaffold["source"]): Promise<GoalScaffold[]> {
  if (!existsSync(baseDir)) return [];
  const scaffolds: GoalScaffold[] = [];
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scaffold = await readScaffoldFile(baseDir, entry.name, source);
    if (scaffold) scaffolds.push(scaffold);
  }
  return scaffolds;
}

export async function loadScaffold(dirs: ScaffoldDirectories, id = "default"): Promise<GoalScaffold> {
  for (const [base, source] of [[dirs.project, "project"], [dirs.user, "user"], [dirs.bundled, "bundled"]] as const) {
    const scaffold = await readScaffoldFile(base, id, source);
    if (scaffold) return scaffold;
  }
  return id === "default" ? FALLBACK_DEFAULT_SCAFFOLD : loadScaffold(dirs, "default");
}

export async function listScaffolds(dirs: ScaffoldDirectories): Promise<GoalScaffold[]> {
  const byId = new Map<string, GoalScaffold>();
  for (const [base, source] of [[dirs.bundled, "bundled"], [dirs.user, "user"], [dirs.project, "project"]] as const) {
    for (const scaffold of await listScaffoldsFromDir(base, source)) byId.set(scaffold.id, scaffold);
  }
  if (!byId.has("default")) byId.set("default", FALLBACK_DEFAULT_SCAFFOLD);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
