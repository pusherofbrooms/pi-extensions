import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalAssistantText } from "../agent-runner.ts";

// Only the fields consumed by this pure helper are needed.
const messages = (items: unknown[]) => items as Message[];
const text = (value: string) => ({ type: "text", text: value });

test("final assistant text joins all text blocks in order, ignoring other blocks and messages", () => {
  assert.equal(getFinalAssistantText(messages([
    { role: "assistant", content: [text("old")] },
    { role: "assistant", content: [text("Hello "), { type: "thinking", thinking: "synthetic" }, text("world"), { type: "toolCall", id: "1", name: "test", arguments: {} }, text("!")] },
    { role: "user", content: "later" },
  ])), "Hello world!");
});

test("assistant messages without text preserve fallback to earlier assistant text", () => {
  for (const content of [[], [{ type: "thinking", thinking: "synthetic" }]]) {
    assert.equal(getFinalAssistantText(messages([
      { role: "assistant", content: [text("old")] },
      { role: "assistant", content },
    ])), "old");
  }
});

test("missing assistant text is empty", () => {
  assert.equal(getFinalAssistantText([]), "");
  assert.equal(getFinalAssistantText(messages([{ role: "user", content: "hello" }])), "");
});
