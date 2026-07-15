import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const CONFIG_PATH = join(getAgentDir(), "bash-read-only.json");
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ARGS = 64;
const MAX_TAIL_LINES = 10_000;
const MAX_JOURNAL_LINES = 1_000;

export type ReadOnlyRule = { executable: string; args?: string[] };
type Config = { additions?: ReadOnlyRule[] };
export type BashReadOnlyOptions = { allowGlobalAdditions?: boolean };

function safeToken(value: string): boolean {
  return value.length <= 4096 && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}
function all(args: readonly string[], values: RegExp): boolean { return args.every((arg) => values.test(arg)); }
function boundedInteger(value: string, max: number, allowZero = false): boolean {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= max && Number(value) >= (allowZero ? 0 : 1);
}

function tailAllowed(args: readonly string[]): boolean {
  let bounded = false, files = 0, after = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { after = true; continue; }
    if (!after && (arg === "-n" || arg === "--lines")) { if (++i >= args.length || !boundedInteger(args[i], MAX_TAIL_LINES)) return false; bounded = true; continue; }
    const match = !after && arg.match(/^--lines=(\d+)$/);
    if (match) { if (!boundedInteger(match[1], MAX_TAIL_LINES)) return false; bounded = true; continue; }
    if (!after && /^-\d+$/.test(arg)) { if (!boundedInteger(arg.slice(1), MAX_TAIL_LINES)) return false; bounded = true; continue; }
    if (!after && arg.startsWith("-")) return false;
    files++;
  }
  return bounded && files > 0;
}

function journalAllowed(args: readonly string[]): boolean {
  let bounded = false, noPager = false;
  const valueOptions = new Set(["-u", "--unit", "--user-unit", "-p", "--priority", "--since", "--until", "-t", "--identifier", "_PID", "_UID", "_COMM", "_EXE", "_SYSTEMD_UNIT"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-pager") { noPager = true; continue; }
    if (arg === "-n" || arg === "--lines") { if (++i >= args.length || !boundedInteger(args[i], MAX_JOURNAL_LINES, true)) return false; bounded = true; continue; }
    const lines = arg.match(/^--lines=(\d+)$/); if (lines) { if (!boundedInteger(lines[1], MAX_JOURNAL_LINES, true)) return false; bounded = true; continue; }
    if (["-b", "--boot", "-k", "--dmesg", "-r", "--reverse", "-q", "--quiet", "--utc", "--user", "--system", "-x", "--catalog", "--no-hostname"].includes(arg)) continue;
    const assignment = arg.match(/^(_PID|_UID|_COMM|_EXE|_SYSTEMD_UNIT)=(.{1,256})$/); if (assignment) continue;
    if (valueOptions.has(arg)) { if (++i >= args.length || args[i].startsWith("-") || args[i].length > 256) return false; continue; }
    if (/^--(unit|user-unit|priority|since|until|identifier)=.{1,256}$/.test(arg)) continue;
    return false;
  }
  return bounded && noPager;
}

export function buildGitArgs(args: readonly string[]): string[] {
  const disableContentDrivers = ["diff", "log", "show"].includes(args[0]) ? ["--no-ext-diff", "--no-textconv"] : [];
  return ["--no-pager", "-c", "core.fsmonitor=false", ...args.slice(0, 1), ...disableContentDrivers, ...args.slice(1)];
}

function gitAllowed(args: readonly string[]): boolean {
  if (!args.length) return false;
  const sub = args[0], rest = args.slice(1);
  if (sub === "status") return all(rest, /^(--short|-s|--branch|-b|--porcelain(?:=v[12])?|--untracked-files=(?:no|normal|all)|--ignored(?:=(?:traditional|matching|no))?)$/);
  if (sub === "branch") return all(rest, /^(--list|-l|--all|-a|--remotes|-r|--verbose|-v|-vv|--no-color)$/);
  if (sub === "rev-parse") return rest.length > 0 && all(rest, /^(--show-toplevel|--show-prefix|--is-inside-work-tree|--is-bare-repository|--git-dir|--abbrev-ref|--verify|HEAD|[A-Za-z0-9._\/-]+(?:\^\{(?:commit|tree|tag|object)\})?)$/);
  if (!["log", "show", "diff"].includes(sub)) return false;
  const option = /^(--oneline|--stat|--shortstat|--name-only|--name-status|--summary|--no-color|--decorate(?:=short|=full|=auto|=no)?|--reverse|--patch|-p|-U\d{1,3}|--unified=\d{1,3}|-[n]?\d{1,4}|--max-count=\d{1,4}|--since=.{1,128}|--until=.{1,128}|--)$/;
  return all(rest, /^(--oneline|--stat|--shortstat|--name-only|--name-status|--summary|--no-color|--decorate(?:=short|=full|=auto|=no)?|--reverse|--patch|-p|-U\d{1,3}|--unified=\d{1,3}|-[n]?\d{1,4}|--max-count=\d{1,4}|--since=.{1,128}|--until=.{1,128}|--|HEAD|[A-Za-z0-9._\/-]+(?:\.{2,3}[A-Za-z0-9._\/-]+)?|:\/?[A-Za-z0-9._\/-]+)$/) && rest.every((arg) => !arg.startsWith("-") || option.test(arg));
}

export function isBuiltInAllowed(executable: string, args: readonly string[]): boolean {
  if (args.length > MAX_ARGS || !args.every(safeToken)) return false;
  switch (executable) {
    case "ps": return args.length === 0 || (args.length === 1 && ["-ef", "aux", "-e", "-A", "ax", "x", "--everyone", "--forest", "--no-headers"].includes(args[0]));
    case "vmstat": return args.length === 0 || all(args, /^(?:-[sDdSm]|\d{1,4})$/) && args.filter((a) => /^\d+$/.test(a)).length <= 2 && !args.some((a) => /^\d+$/.test(a) && !boundedInteger(a, 1000));
    case "uptime": return all(args, /^(?:-p|--pretty|-s|--since)$/);
    case "uname": return all(args, /^-(?:[asnrvmpio]+|-all|-kernel-name|-nodename|-kernel-release|-kernel-version|-machine|-processor|-hardware-platform|-operating-system)$/);
    case "df": return all(args, /^(?:-[hHPTaiklm]+|--(?:human-readable|si|print-type|portability|all|inodes|local|no-sync|sync)|--output(?:=[A-Za-z,]+)?|[^-].*)$/);
    case "free": return all(args, /^(?:-[bhkmgtw]+|--(?:bytes|kibi|mebi|gibi|tebi|wide|lohi|human|si))$/);
    case "who": return all(args, /^(?:-[aHqTu]+|--(?:all|heading|count|users|message|writable))$/);
    case "id": return all(args, /^(?:-[ugGnrz]+|--(?:user|group|groups|name|real|zero)|[A-Za-z0-9._-]+)$/) && args.filter((a) => !a.startsWith("-")).length <= 1;
    case "date": return all(args, /^(?:-u|--utc|--universal|--iso-8601(?:=(?:date|hours|minutes|seconds|ns))?|--rfc-3339=(?:date|seconds|ns)|--rfc-email|\+[^\r\n]{1,256})$/);
    case "tail": return tailAllowed(args);
    case "journalctl": return journalAllowed(args);
    case "git": return gitAllowed(args);
    default: return false;
  }
}

export function isConfiguredAllowed(executable: string, args: readonly string[], rules: readonly ReadOnlyRule[]): boolean {
  return rules.some((rule) => rule.executable === executable && Array.isArray(rule.args) && rule.args.length === args.length && rule.args.every((arg, i) => arg === args[i]));
}
export function isConfined(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }

async function loadRules(): Promise<ReadOnlyRule[]> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
    return Array.isArray(parsed.additions) ? parsed.additions.filter((rule) => rule && typeof rule.executable === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(rule.executable) && Array.isArray(rule.args) && rule.args.length <= MAX_ARGS && rule.args.every((arg) => typeof arg === "string" && safeToken(arg))) : [];
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`Invalid trusted bash_read_only config ${CONFIG_PATH}: ${(error as Error).message}`); }
}

async function prepareTailFiles(root: string, args: readonly string[]): Promise<{ args: string[]; handles: FileHandle[] }> {
  let after = false;
  const prepared: string[] = [];
  const handles: FileHandle[] = [];
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") { after = true; prepared.push(arg); continue; }
      if (!after && (arg === "-n" || arg === "--lines")) { prepared.push(arg, args[++i]); continue; }
      if (!after && (arg.startsWith("--lines=") || /^-\d+$/.test(arg))) { prepared.push(arg); continue; }
      const resolved = await realpath(isAbsolute(arg) ? arg : join(root, arg));
      if (!isConfined(root, resolved)) throw new Error(`tail path escapes session cwd: ${arg}`);
      const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile()) { await handle.close(); throw new Error(`tail path is not a regular file: ${arg}`); }
      handles.push(handle);
      prepared.push(`/dev/fd/${handles.length + 2}`);
    }
    return { args: prepared, handles };
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    throw error;
  }
}

export async function executeReadOnly(executable: string, args: string[], requestedCwd: string | undefined, sessionCwd: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal, options: BashReadOnlyOptions = {}): Promise<{ stdout: string; stderr: string; code: number | null; truncated: boolean; reason?: "aborted" | "timeout" | "output-limit" }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(executable) || executable === "." || executable === "..") throw new Error("Executable must be an allowed command name, not a path");
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("timeoutMs must be a finite integer from 100 through 30000");
  if (signal?.aborted) throw new Error("Command aborted before start");
  const rules = options.allowGlobalAdditions === false ? [] : await loadRules();
  if (!isBuiltInAllowed(executable, args) && !isConfiguredAllowed(executable, args, rules)) throw new Error(`Denied read-only command: ${executable}`);
  const root = await realpath(sessionCwd), cwd = await realpath(requestedCwd ? (isAbsolute(requestedCwd) ? requestedCwd : join(root, requestedCwd)) : root);
  if (!isConfined(root, cwd)) throw new Error("cwd must remain within the session cwd");
  const tail = executable === "tail" ? await prepareTailFiles(root, args) : undefined;
  const commandArgs = executable === "git" ? buildGitArgs(args) : tail?.args ?? args;

  return await new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const closeHandles = () => { if (tail) void Promise.allSettled(tail.handles.map((handle) => handle.close())); };
    const child = spawn(executable, commandArgs, { cwd, shell: false, detached: grouped, env: { PATH: SAFE_PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe", ...(tail?.handles.map((handle) => handle.fd) ?? [])] });
    let stdout = "", stderr = "", received = 0, settled = false, reason: "aborted" | "timeout" | "output-limit" | undefined;
    const kill = (why: typeof reason) => { if (!reason) reason = why; try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const collect = (target: "stdout" | "stderr") => (chunk: Buffer) => {
      received += chunk.length;
      const current = target === "stdout" ? stdout : stderr;
      const remaining = Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(current));
      const next = current + chunk.subarray(0, remaining).toString();
      if (target === "stdout") stdout = next; else stderr = next;
      if (received > DEFAULT_MAX_BYTES * 2) kill("output-limit");
    };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    const abort = () => kill("aborted"); signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); closeHandles(); reject(error); } });
    child.on("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); closeHandles(); const out = truncateHead(stdout, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }); const err = truncateHead(stderr, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }); resolve({ stdout: out.content, stderr: err.content, code, truncated: Boolean(reason === "output-limit" || out.truncated || err.truncated), reason }); });
  });
}

export function createBashReadOnlyExtension(options: BashReadOnlyOptions = {}) {
  return function bashReadOnlyExtension(pi: ExtensionAPI) {
    pi.registerTool({ name: "bash_read_only", label: "Bash (read only)", description: "Run a deny-by-default inspection command as a structured executable and argument array. No shell, pipes, redirects, or executable paths.", parameters: Type.Object({ executable: Type.String(), args: Type.Array(Type.String(), { maxItems: MAX_ARGS }), cwd: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })) }), async execute(_id, params, signal, _update, ctx) { const result = await executeReadOnly(params.executable, params.args, params.cwd, ctx.cwd, params.timeoutMs, signal, options); const reason = result.reason ? `; ${result.reason}` : ""; return { content: [{ type: "text", text: `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}${result.truncated ? "\n[output truncated]" : ""}\n[exit ${result.code ?? "signal"}${reason}]` }], details: result }; } });
  };
}
export default createBashReadOnlyExtension();
