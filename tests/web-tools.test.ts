import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FETCH_RESPONSE_BYTES,
  extractWithDefuddle,
  fetchPage,
  isHostnameAllowed,
} from "../web-tools.ts";

const articleHtml = `<!doctype html><html><head><title>Useful article</title><meta name="author" content="Ada"></head><body>
<header><nav><a href="/home">Home</a> <a href="/pricing">Pricing</a></nav></header>
<main><article><h1>Useful article</h1><p>This is the substantive opening paragraph with enough prose to identify it as article content.</p><h2>Example</h2><pre><code class="language-ts">const answer = 42;</code></pre><p>Another substantive paragraph completes the article and gives the extractor useful context.</p></article><aside>Related promotions and unrelated links</aside></main>
<footer>Copyright and privacy links</footer></body></html>`;

test("Defuddle returns structured Markdown and removes obvious chrome", async () => {
  const result = await extractWithDefuddle(articleHtml, "https://example.com/posts/useful");
  assert.equal(result.title, "Useful article");
  assert.match(result.markdown, /## Example/);
  assert.match(result.markdown, /```ts/);
  assert.doesNotMatch(result.markdown, /Pricing|Copyright|Related promotions/);
});

test("Defuddle retains sections after a Wikipedia-style mid-article image row", async () => {
  const html = `<!doctype html><html><head><title>Example topic</title></head><body><main><article>
    <section><h2>Background</h2><p>Early accounts were largely anecdotal, drawing on field notes from researchers working in several countries without a shared vocabulary for their observations.</p></section>
    <section><h2>Methods</h2><div class="tmulti"><div class="trow">
      <div class="tsingle"><a href="/wiki/File:One"><img src="one.jpg" alt="First apparatus"></a><a href="/wiki/One">First apparatus</a></div>
      <div class="tsingle"><a href="/wiki/File:Two"><img src="two.jpg" alt="Second apparatus"></a><a href="/wiki/Two">Second apparatus</a></div>
    </div></div><p>Contemporary studies use a standard protocol. Samples are collected on a fixed schedule and cross-checked by a second team before analysis begins.</p></section>
    <section><h2>Later findings</h2><p>The consolidated dataset shows a consistent seasonal pattern across every site. This later section must remain in the extracted article.</p></section>
  </article></main></body></html>`;

  const result = await extractWithDefuddle(html, "https://en.wikipedia.org/wiki/Example_topic");
  assert.match(result.markdown, /## Methods/);
  assert.match(result.markdown, /## Later findings/);
  assert.match(result.markdown, /This later section must remain/);
});

test("fetch host allowlist defaults to all public hostnames", () => {
  assert.equal(isHostnameAllowed("example.com", undefined), true);
  assert.equal(isHostnameAllowed("example.com", []), false);
  assert.equal(isHostnameAllowed("anything.example", ["*"]), true);
});

test("fetch host allowlist supports exact hosts and explicit subdomain wildcards", () => {
  const patterns = ["docs.example.com", "*.wikipedia.org"];
  assert.equal(isHostnameAllowed("docs.example.com", patterns), true);
  assert.equal(isHostnameAllowed("api.example.com", patterns), false);
  assert.equal(isHostnameAllowed("en.wikipedia.org", patterns), true);
  assert.equal(isHostnameAllowed("deep.en.wikipedia.org", patterns), true);
  assert.equal(isHostnameAllowed("wikipedia.org", patterns), false);
  assert.equal(isHostnameAllowed("notwikipedia.org", patterns), false);
});

test("fetch host allowlist rejects ambiguous glob patterns", () => {
  assert.throws(() => isHostnameAllowed("example.com", ["example.*"]), /Invalid WEB_FETCH_ALLOWED_HOSTS pattern/);
  assert.throws(() => isHostnameAllowed("example.com", ["*."]), /Invalid WEB_FETCH_ALLOWED_HOSTS pattern/);
  assert.throws(() => isHostnameAllowed("example.com", ["https:\/\/example.com"]), /Invalid WEB_FETCH_ALLOWED_HOSTS pattern/);
});

test("fetch_page rejects IPv6 loopback before fetching", async () => {
  await assert.rejects(fetchPage("http://[::1]"), /Blocked private IP host/);
});

test("fetch_page rejects an oversized response from content-length before reading it", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: {
      "content-length": String(MAX_FETCH_RESPONSE_BYTES + 1),
      "content-type": "text/plain",
    },
  });

  try {
    await assert.rejects(
      fetchPage("http://93.184.216.34/large"),
      /Response exceeds maximum size/,
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_page stops a chunked response when it exceeds the size limit", async () => {
  const originalFetch = globalThis.fetch;
  const chunk = new Uint8Array(MAX_FETCH_RESPONSE_BYTES + 1);
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
    },
  }), { status: 200, headers: { "content-type": "text/plain" } });

  try {
    await assert.rejects(
      fetchPage("http://93.184.216.34/large"),
      /Response exceeds maximum size/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_page applies the allowlist to redirect destinations", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response(null, { status: 302, headers: { location: "https://disallowed.example/next" } });
  };

  try {
    await assert.rejects(
      fetchPage("http://93.184.216.34/start", undefined, { allowedHosts: ["93.184.216.34"] }),
      /Hostname is not allowed/,
    );
    assert.deepEqual(requested, ["http://93.184.216.34/start"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
