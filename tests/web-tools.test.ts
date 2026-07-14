import assert from "node:assert/strict";
import test from "node:test";
import { defuddleOptionsForUrl, extractWithDefuddle } from "../web-tools.ts";

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

test("Wikipedia workaround disables Defuddle content-pattern removal", () => {
  assert.equal(defuddleOptionsForUrl("https://en.wikipedia.org/wiki/Example").removeContentPatterns, false);
  assert.equal(defuddleOptionsForUrl("https://wikipedia.org/wiki/Example").removeContentPatterns, false);
  assert.equal("removeContentPatterns" in defuddleOptionsForUrl("https://example.com/article"), false);
});
