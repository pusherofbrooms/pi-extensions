import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";

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

type OptionPolicy = {
  flags: ReadonlySet<string>;
  values: ReadonlyMap<string, (value: string) => boolean>;
  finish: (positionals: readonly string[], seen: ReadonlySet<string>) => boolean;
};

/** Positive parser shared by conventional tools whose CLI is flags followed by operands. */
function conventionalOptionsAllowed(args: readonly string[], policy: OptionPolicy): boolean {
  const positionals: string[] = [], seen = new Set<string>();
  let afterOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterOptions && arg === "--") { afterOptions = true; continue; }
    if (!afterOptions && arg.startsWith("--") && arg.includes("=")) {
      const split = arg.indexOf("="), option = arg.slice(0, split), value = arg.slice(split + 1), validate = policy.values.get(option);
      if (!validate?.(value)) return false;
      seen.add(option); continue;
    }
    if (!afterOptions && policy.flags.has(arg)) { seen.add(arg); continue; }
    if (!afterOptions && policy.values.has(arg)) {
      if (++i >= args.length || !policy.values.get(arg)!(args[i])) return false;
      seen.add(arg); continue;
    }
    if (!afterOptions && arg.startsWith("-")) return false;
    positionals.push(arg);
  }
  return policy.finish(positionals, seen);
}

const rgValue = (value: string) => value.length > 0;
const rgBound = (max: number) => (value: string) => boundedInteger(value, max, true);
const RG_POLICY: OptionPolicy = {
  flags: new Set([
    "-n", "--line-number", "--hidden", "-S", "--smart-case", "-i", "--ignore-case", "-s", "--case-sensitive",
    "-F", "--fixed-strings", "-w", "--word-regexp", "-x", "--line-regexp", "--no-ignore", "--no-ignore-vcs",
    "-l", "--files-with-matches", "--files-without-match", "-c", "--count", "--count-matches", "--files", "--type-list",
    "--column", "--heading", "--no-heading", "-H", "--with-filename", "-I", "--no-filename", "-0", "--null",
    "--null-data", "--stats", "--json", "-q", "--quiet", "--only-matching", "-o", "--trim",
  ]),
  values: new Map([
    ["-e", rgValue], ["--regexp", rgValue], ["-g", rgValue], ["--glob", rgValue], ["--iglob", rgValue],
    ["-t", (v) => /^[A-Za-z0-9_.+-]+$/.test(v)], ["--type", (v) => /^[A-Za-z0-9_.+-]+$/.test(v)],
    ["-T", (v) => /^[A-Za-z0-9_.+-]+$/.test(v)], ["--type-not", (v) => /^[A-Za-z0-9_.+-]+$/.test(v)],
    ["-A", rgBound(100)], ["--after-context", rgBound(100)], ["-B", rgBound(100)], ["--before-context", rgBound(100)],
    ["-C", rgBound(100)], ["--context", rgBound(100)], ["-m", rgBound(10_000)], ["--max-count", rgBound(10_000)],
    ["--max-depth", rgBound(1_000)], ["--color", (v) => /^(?:never|always|auto|ansi)$/.test(v)],
    ["--sort", (v) => /^(?:path|modified|accessed|created)$/.test(v)],
  ]),
  finish(positionals, seen) {
    const filesMode = seen.has("--files"), typeList = seen.has("--type-list"), explicitPattern = seen.has("-e") || seen.has("--regexp");
    if ((filesMode || typeList) && explicitPattern) return false;
    if (typeList) return positionals.length === 0 && !filesMode;
    if (filesMode) return true;
    return explicitPattern || positionals.length > 0;
  },
};

function splitGitArgs(args: readonly string[]): { globals: string[]; command: string[] } | undefined {
  const globals: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--no-pager") { globals.push(args[i++]); continue; }
    if (args[i] === "-C") {
      if (i + 1 >= args.length) return undefined;
      globals.push(args[i], args[i + 1]); i += 2; continue;
    }
    break;
  }
  return { globals, command: args.slice(i) };
}

export function buildGitArgs(args: readonly string[]): string[] {
  const parsed = splitGitArgs(args);
  if (!parsed) return [...args];
  const [sub, ...rest] = parsed.command;
  const disableContentDrivers = ["diff", "log", "show"].includes(sub) ? ["--no-ext-diff", "--no-textconv"] : [];
  return ["--no-pager", "-c", "core.fsmonitor=false", ...parsed.globals, sub, ...disableContentDrivers, ...rest];
}

function gitAllowed(args: readonly string[]): boolean {
  const parsed = splitGitArgs(args);
  if (!parsed || !parsed.command.length) return false;
  const [sub, ...rest] = parsed.command;
  if (sub === "status") return all(rest, /^(--short|-s|--branch|-b|--porcelain(?:=v[12])?|--untracked-files=(?:no|normal|all)|--ignored(?:=(?:traditional|matching|no))?)$/);
  if (sub === "branch") return all(rest, /^(--list|-l|--all|-a|--remotes|-r|--verbose|-v|-vv|--no-color)$/);
  if (sub === "rev-parse") return rest.length > 0 && all(rest, /^(--show-toplevel|--show-prefix|--is-inside-work-tree|--is-bare-repository|--git-dir|--abbrev-ref|--verify|HEAD|[A-Za-z0-9._\/-]+(?:\^\{(?:commit|tree|tag|object)\})?)$/);
  if (!["log", "show", "diff"].includes(sub)) return false;
  const option = /^(--oneline|--stat|--shortstat|--name-only|--name-status|--summary|--no-color|--decorate(?:=short|=full|=auto|=no)?|--reverse|--patch|-p|-U\d{1,3}|--unified=\d{1,3}|-[n]?\d{1,4}|--max-count=\d{1,4}|--since=.{1,128}|--until=.{1,128}|--)$/;
  return all(rest, /^(--oneline|--stat|--shortstat|--name-only|--name-status|--summary|--no-color|--decorate(?:=short|=full|=auto|=no)?|--reverse|--patch|-p|-U\d{1,3}|--unified=\d{1,3}|-[n]?\d{1,4}|--max-count=\d{1,4}|--since=.{1,128}|--until=.{1,128}|--|HEAD|[A-Za-z0-9._\/-]+(?:\.{2,3}[A-Za-z0-9._\/-]+)?|:\/?[A-Za-z0-9._\/-]+)$/) && rest.every((arg) => !arg.startsWith("-") || option.test(arg));
}

function findAllowed(args: readonly string[]): boolean {
  const dangerous = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-files0-from"]);
  if (!args.length || args.some((arg) => dangerous.has(arg))) return false;
  let i = 0;
  while (i < args.length && ["-H", "-L", "-P"].includes(args[i])) i++;
  let roots = 0;
  while (i < args.length && !args[i].startsWith("-") && !["!", "(", ")"].includes(args[i])) { roots++; i++; }
  if (!roots) return false;

  const valuePrimaries = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-user", "-group", "-uid", "-gid", "-perm", "-links", "-printf"]);
  const nullary = new Set(["-empty", "-readable", "-true", "-false", "-print", "-print0", "-ls"]);
  const numeric = new Set(["-maxdepth", "-mindepth"]);
  const primary = (): boolean => {
    const token = args[i++];
    if (token === "(") { if (!expression() || args[i++] !== ")") return false; return true; }
    if (nullary.has(token)) return true;
    if (numeric.has(token)) return i < args.length && /^\d+$/.test(args[i++]);
    if (token === "-type" || token === "-xtype") return i < args.length && /^[bcdpflsD]$/.test(args[i++]);
    if (valuePrimaries.has(token)) return i < args.length && Boolean(args[i++]);
    return false;
  };
  const negation = (): boolean => { while (["!", "-not"].includes(args[i])) i++; return primary(); };
  const conjunction = (): boolean => {
    if (!negation()) return false;
    while (i < args.length && args[i] !== ")" && !["-o", "-or"].includes(args[i])) {
      if (["-a", "-and"].includes(args[i])) i++;
      if (!negation()) return false;
    }
    return true;
  };
  function expression(): boolean {
    if (!conjunction()) return false;
    while (["-o", "-or"].includes(args[i])) { i++; if (!conjunction()) return false; }
    return true;
  }
  return i === args.length || expression() && i === args.length;
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
    case "find": return findAllowed(args);
    case "git": return gitAllowed(args);
    case "rg": return conventionalOptionsAllowed(args, RG_POLICY);
    default: return false;
  }
}

export function isConfiguredAllowed(executable: string, args: readonly string[], rules: readonly ReadOnlyRule[]): boolean {
  return rules.some((rule) => rule.executable === executable && Array.isArray(rule.args) && rule.args.length === args.length && rule.args.every((arg, i) => arg === args[i]));
}
async function loadRules(): Promise<ReadOnlyRule[]> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
    return Array.isArray(parsed.additions) ? parsed.additions.filter((rule) => rule && typeof rule.executable === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(rule.executable) && Array.isArray(rule.args) && rule.args.length <= MAX_ARGS && rule.args.every((arg) => typeof arg === "string" && safeToken(arg))) : [];
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`Invalid trusted bash_read_only config ${CONFIG_PATH}: ${(error as Error).message}`); }
}

export function childEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: parent.PATH || SAFE_PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

async function prepareTailFiles(cwd: string, args: readonly string[]): Promise<{ args: string[]; handles: FileHandle[] }> {
  let after = false;
  const prepared: string[] = [];
  const handles: FileHandle[] = [];
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") { after = true; prepared.push(arg); continue; }
      if (!after && (arg === "-n" || arg === "--lines")) { prepared.push(arg, args[++i]); continue; }
      if (!after && (arg.startsWith("--lines=") || /^-\d+$/.test(arg))) { prepared.push(arg); continue; }
      const resolved = await realpath(isAbsolute(arg) ? arg : join(cwd, arg));
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
  const tail = executable === "tail" ? await prepareTailFiles(cwd, args) : undefined;
  const commandArgs = executable === "git" ? buildGitArgs(args) : tail?.args ?? args;

  return await new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const closeHandles = () => { if (tail) void Promise.allSettled(tail.handles.map((handle) => handle.close())); };
    const child = spawn(executable, commandArgs, { cwd, shell: false, detached: grouped, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe", ...(tail?.handles.map((handle) => handle.fd) ?? [])] });
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
    pi.registerTool({ name: "bash_read_only", label: "Bash (read only)", description: "Run a mostly-safe, deny-by-default inspection command as a structured executable and argument array. Primarily non-mutating, but inspection can have incidental side effects; this is not a sandbox. Explicit readable paths outside cwd are allowed. No shell, pipes, redirects, or executable paths.", parameters: Type.Object({ executable: Type.String(), args: Type.Array(Type.String(), { maxItems: MAX_ARGS }), cwd: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })) }), async execute(_id, params, signal, _update, ctx) { const result = await executeReadOnly(params.executable, params.args, params.cwd, ctx.cwd, params.timeoutMs, signal, options); const reason = result.reason ? `; ${result.reason}` : ""; return { content: [{ type: "text", text: `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}${result.truncated ? "\n[output truncated]" : ""}\n[exit ${result.code ?? "signal"}${reason}]` }], details: result }; } });
  };
}
export default createBashReadOnlyExtension();
