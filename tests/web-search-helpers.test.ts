import assert from "node:assert/strict";
import test from "node:test";
import { decodeDuckDuckGoRedirect, fetchJson, fetchText, MAX_FETCH_RESPONSE_BYTES } from "../web-tools.ts";

test("DuckDuckGo redirects preserve encoded destination query values", () => {
  const destination = "https://example.com/?q=a%26b%3Dc%25&path=%2Fdocs&space=a+b";
  assert.equal(decodeDuckDuckGoRedirect(`/l/?uddg=${encodeURIComponent(destination)}`), destination);
  assert.equal(decodeDuckDuckGoRedirect(destination), destination);
  assert.equal(decodeDuckDuckGoRedirect("/l/?other=value"), "/l/?other=value");
});

for (const helper of [fetchJson, fetchText]) {
  test(`${helper.name} reads bounded success and error bodies`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response('{"value":"synthetic"}'));
    assert.deepEqual(await helper("https://example.com"), helper === fetchJson ? { value: "synthetic" } : '{"value":"synthetic"}');
    t.mock.method(globalThis, "fetch", async () => new Response("synthetic failure", { status: 400, statusText: "Bad Request" }));
    await assert.rejects(helper("https://example.com"), /HTTP 400 Bad Request - synthetic failure/);
  });

  for (const status of [200, 500]) {
    for (const declared of [true, false]) {
      test(`${helper.name} cancels oversized ${status} body (${declared ? "declared" : "streamed"})`, async (t) => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(MAX_FETCH_RESPONSE_BYTES + 1));
          },
          cancel() { cancelled = true; },
        });
        t.mock.method(globalThis, "fetch", async () => new Response(body, {
          status,
          headers: declared ? { "content-length": String(MAX_FETCH_RESPONSE_BYTES + 1) } : {},
        }));
        await assert.rejects(helper("https://example.com"), /Response exceeds maximum size/);
        assert.equal(cancelled, true);
      });
    }
  }
}
