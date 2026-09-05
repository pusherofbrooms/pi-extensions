import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { Type } from "typebox";
import { lookup } from "node:dns/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

type SearchProvider = "brave" | "tavily" | "serpapi" | "duckduckgo";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

export const MAX_FETCH_RESPONSE_BYTES = 5 * 1024 * 1024;

function getSearchProvider(): SearchProvider {
  const value = (process.env.WEB_SEARCH_PROVIDER ?? "duckduckgo").toLowerCase();
  if (value === "brave" || value === "tavily" || value === "serpapi" || value === "duckduckgo" || value === "ddg") {
    return value === "ddg" ? "duckduckgo" : value;
  }
  return "duckduckgo";
}

function getTimeoutMs(): number {
  const raw = Number(process.env.WEB_TOOL_TIMEOUT_MS ?? "15000");
  if (!Number.isFinite(raw)) return 15_000;
  return Math.max(2_000, Math.min(60_000, Math.floor(raw)));
}

function configuredAllowedHosts(): string[] | undefined {
  const raw = process.env.WEB_FETCH_ALLOWED_HOSTS?.trim();
  if (!raw) return undefined;
  return raw.split(",").map((pattern) => pattern.trim()).filter(Boolean);
}

export function isHostnameAllowed(hostname: string, patterns: readonly string[] | undefined): boolean {
  if (patterns === undefined) return true;
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedPatterns = patterns.map((rawPattern) => {
    const lowerPattern = rawPattern.toLowerCase();
    if (lowerPattern === "*.") throw new Error(`Invalid WEB_FETCH_ALLOWED_HOSTS pattern: ${rawPattern}`);
    const pattern = lowerPattern.replace(/\.$/, "");
    if (pattern === "*") return pattern;
    const wildcardSuffix = pattern.startsWith("*.") ? pattern.slice(2) : undefined;
    const candidate = wildcardSuffix ?? pattern;
    if (
      !candidate ||
      (pattern !== "*" && pattern.includes("*") && wildcardSuffix === undefined) ||
      candidate.includes("*") ||
      candidate.includes(":") ||
      candidate.includes("/") ||
      candidate.includes("?")
    ) {
      throw new Error(`Invalid WEB_FETCH_ALLOWED_HOSTS pattern: ${rawPattern}`);
    }
    return pattern;
  });

  return normalizedPatterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return normalizedHostname !== suffix && normalizedHostname.endsWith(`.${suffix}`);
    }
    return normalizedHostname === pattern;
  });
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.includes(":")) {
    if (normalized === "::" || normalized === "::1") return true;
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)) return true;
    // IPv4-mapped IPv6 can represent private IPv4 in several equivalent forms;
    // block the whole mapped range rather than risk alternate-notation bypasses.
    if (normalized.startsWith("::ffff:")) return true;
    return false;
  }

  const parts = normalized.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;

  return false;
}

async function assertSafePublicUrl(input: string, allowedHosts: readonly string[] | undefined): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();
  if (!isHostnameAllowed(hostname, allowedHosts)) {
    throw new Error(`Hostname is not allowed by WEB_FETCH_ALLOWED_HOSTS: ${hostname}`);
  }
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith(".local")) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Blocked private IP host: ${hostname}`);
    }
    return url;
  }

  try {
    const records = await lookup(hostname, { all: true });
    for (const record of records) {
      if (isPrivateIp(record.address)) {
        throw new Error(`Hostname resolves to private IP: ${record.address}`);
      }
    }
  } catch (error) {
    throw new Error(`DNS validation failed for ${hostname}: ${(error as Error).message}`);
  }

  return url;
}

async function readResponseText(response: Response, maxBytes = MAX_FETCH_RESPONSE_BYTES): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds maximum size of ${formatSize(maxBytes)}`);
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds maximum size of ${formatSize(maxBytes)}`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = getTimeoutMs()): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": process.env.WEB_TOOL_USER_AGENT ?? "pi-web-tools/0.1",
        ...(init.headers ?? {}),
      },
    });

    const body = await readResponseText(res);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` - ${body.slice(0, 300)}` : ""}`);
    }

    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, init: RequestInit = {}, timeoutMs = getTimeoutMs()): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": process.env.WEB_TOOL_USER_AGENT ?? "pi-web-tools/0.1",
        ...(init.headers ?? {}),
      },
    });

    const body = await readResponseText(res);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` - ${body.slice(0, 300)}` : ""}`);
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function decodeDuckDuckGoRedirect(url: string): string {
  if (!url.startsWith("/")) return url;

  try {
    const parsed = new URL(`https://duckduckgo.com${url}`);
    const redirected = parsed.searchParams.get("uddg");
    if (redirected) return redirected;
  } catch {
    // ignore parse failures and return original
  }

  return url;
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

async function runDuckDuckGoSearch(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const html = await fetchText(url.toString(), {
    headers: {
      Accept: "text/html",
    },
  });

  const blocks = html.match(/<div class="result[\s\S]*?<\/div>\s*<\/div>/gi) ?? [];
  const results: SearchResult[] = [];

  for (const block of blocks) {
    if (results.length >= limit) break;

    const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const rawUrl = decodeEntities(linkMatch[1]);
    const resolvedUrl = decodeDuckDuckGoRedirect(rawUrl);
    if (!resolvedUrl || resolvedUrl.startsWith("/")) continue;

    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);

    results.push({
      title: stripTags(linkMatch[2]) || "(untitled)",
      url: resolvedUrl,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : undefined,
    });
  }

  return results;
}

async function runSearch(query: string, limit: number): Promise<{ provider: SearchProvider; results: SearchResult[] }> {
  const provider = getSearchProvider();

  if (provider === "duckduckgo") {
    const results = await runDuckDuckGoSearch(query, limit);
    return { provider, results: results.slice(0, limit) };
  }

  if (provider === "brave") {
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) {
      throw new Error("Missing BRAVE_API_KEY for provider=brave");
    }

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));

    const data = await fetchJson(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });

    const results: SearchResult[] = (data?.web?.results ?? []).map((r: any) => ({
      title: String(r.title ?? "(untitled)"),
      url: String(r.url ?? ""),
      snippet: r.description ? String(r.description) : undefined,
    }));

    return { provider, results: results.filter((r) => r.url).slice(0, limit) };
  }

  if (provider === "tavily") {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error("Missing TAVILY_API_KEY for provider=tavily");
    }

    const data = await fetchJson("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
        include_raw_content: false,
      }),
    });

    const results: SearchResult[] = (data?.results ?? []).map((r: any) => ({
      title: String(r.title ?? "(untitled)"),
      url: String(r.url ?? ""),
      snippet: r.content ? String(r.content) : undefined,
    }));

    return { provider, results: results.filter((r) => r.url).slice(0, limit) };
  }

  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing SERPAPI_API_KEY for provider=serpapi");
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(limit));
  url.searchParams.set("api_key", apiKey);

  const data = await fetchJson(url.toString());
  const results: SearchResult[] = (data?.organic_results ?? []).map((r: any) => ({
    title: String(r.title ?? "(untitled)"),
    url: String(r.link ?? ""),
    snippet: r.snippet ? String(r.snippet) : undefined,
  }));

  return { provider, results: results.filter((r) => r.url).slice(0, limit) };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const codePoint = Number.parseInt(dec, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export type ExtractedPage = {
  title?: string;
  author?: string;
  published?: string;
  site?: string;
  description?: string;
  markdown: string;
};

export async function extractWithDefuddle(html: string, url: string): Promise<ExtractedPage> {
  const { document } = parseHTML(html);
  const result = await Defuddle(document, url, {
    markdown: true,
    useAsync: false,
  });
  const markdown = result.content?.trim();
  if (!markdown) {
    throw new Error("Defuddle found no readable content. Use agent-browser for this page.");
  }
  return {
    title: result.title || undefined,
    author: result.author || undefined,
    published: result.published || undefined,
    site: result.site || undefined,
    description: result.description || undefined,
    markdown,
  };
}

export interface FetchPageOptions {
  allowedHosts?: readonly string[];
}

export async function fetchPage(url: string, signal?: AbortSignal, options: FetchPageOptions = {}): Promise<{
  url: string;
  title?: string;
  author?: string;
  published?: string;
  site?: string;
  description?: string;
  contentType: string;
  status: number;
  text: string;
  truncated: boolean;
  truncationNote?: string;
}> {
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

  try {
    const allowedHosts = options.allowedHosts ?? configuredAllowedHosts();
    let currentUrl = await assertSafePublicUrl(url, allowedHosts);
    let response: Response | undefined;

    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        signal: requestSignal,
        headers: {
          "User-Agent": process.env.WEB_TOOL_USER_AGENT ?? "pi-web-tools/0.1",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
        },
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) break;

      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = await assertSafePublicUrl(new URL(location, currentUrl).toString(), allowedHosts);
    }

    if (!response) throw new Error("No response received.");

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error("Too many redirects while fetching page.");
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch page: HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const body = await readResponseText(response);

    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    const extracted = isHtml ? await extractWithDefuddle(body, response.url || currentUrl.toString()) : undefined;
    const extractedText = extracted?.markdown ?? body;

    const truncation = truncateHead(extractedText, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });

    let truncationNote: string | undefined;
    if (truncation.truncated) {
      const dir = await mkdtemp(join(tmpdir(), "pi-web-tools-"));
      const fullOutputPath = join(dir, "full-page.txt");
      await writeFile(fullOutputPath, extractedText, "utf8");
      truncationNote = `Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full text saved to ${fullOutputPath}`;
    }

    return {
      url: response.url,
      title: extracted?.title,
      author: extracted?.author,
      published: extracted?.published,
      site: extracted?.site,
      description: extracted?.description,
      contentType,
      status: response.status,
      text: truncation.content,
      truncated: truncation.truncated,
      truncationNote,
    };
  } finally {
    clearTimeout(timer);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web for recent information. Uses provider set by WEB_SEARCH_PROVIDER (duckduckgo|brave|tavily|serpapi). DuckDuckGo requires no API key; other providers require matching API key env var (BRAVE_API_KEY, TAVILY_API_KEY, or SERPAPI_API_KEY).",
    promptSnippet: "Search the public web for recent information and return ranked results with snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({
          description: "Max number of results (default 5, max 10)",
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const limit = Math.max(1, Math.min(10, Math.floor(params.limit ?? 5)));
      const { provider, results } = await runSearch(params.query, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for query: ${params.query}` }],
          details: {
            provider,
            query: params.query,
            count: 0,
            results: [],
          },
        };
      }

      const text = [
        `Search provider: ${provider}`,
        `Query: ${params.query}`,
        "",
        ...results.map((result, index) => {
          const snippet = result.snippet ? `\n   Snippet: ${result.snippet}` : "";
          return `${index + 1}. ${result.title}\n   URL: ${result.url}${snippet}`;
        }),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          provider,
          query: params.query,
          count: results.length,
          results,
        },
      };
    },
  });

  pi.registerTool({
    name: "fetch_page",
    label: "Fetch Page",
    description:
      "Fetch an allowed public HTTP(S) page and extract its main content as Markdown with Defuddle. Best for articles and documentation; does not execute JavaScript. Includes SSRF protections and honors WEB_FETCH_ALLOWED_HOSTS when configured. Use agent-browser for interactive or client-rendered pages.",
    promptSnippet: "Fetch a public page and extract high-quality main content as Markdown; use agent-browser when JavaScript or interaction is required.",
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
    }),
    async execute(_toolCallId, params, signal) {
      const page = await fetchPage(params.url, signal);
      const header = [
        `Fetched: ${page.url}`,
        page.title ? `Title: ${page.title}` : undefined,
        page.author ? `Author: ${page.author}` : undefined,
        page.published ? `Published: ${page.published}` : undefined,
        page.site ? `Site: ${page.site}` : undefined,
        `Status: ${page.status}`,
        `Content-Type: ${page.contentType || "unknown"}`,
      ]
        .filter(Boolean)
        .join("\n");

      const text = page.truncationNote
        ? `${header}\n\n${page.text}\n\n[${page.truncationNote}]`
        : `${header}\n\n${page.text}`;

      return {
        content: [{ type: "text", text }],
        details: {
          url: page.url,
          title: page.title,
          author: page.author,
          published: page.published,
          site: page.site,
          description: page.description,
          status: page.status,
          contentType: page.contentType,
          truncated: page.truncated,
          truncationNote: page.truncationNote,
        },
      };
    },
  });
}
