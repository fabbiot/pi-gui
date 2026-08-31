import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, messageText } from "../dist/session-supervisor-utils.js";

const markdownParts = [
  "## Verification report",
  [
    "### Tests",
    "",
    "- Driver regression: passed",
    "- Electron projection: passed",
  ].join("\n"),
  [
    "```text",
    "user prompt -> worker response",
    "```",
  ].join("\n"),
];
const markdownReport = markdownParts.join("\n\n");

test("buildSnapshot projects live Pi context usage without sharing mutable state", () => {
  const contextUsage = { tokens: 96_000, contextWindow: 128_000, percent: 75 };
  const snapshot = buildSnapshot({
    ref: { workspaceId: "workspace-usage", sessionId: "session-usage" },
    workspace: { workspaceId: "workspace-usage", path: "/tmp/context-usage" },
    title: "Context usage",
    status: "idle",
    updatedAt: "2026-08-30T22:50:00.000Z",
    archivedAt: undefined,
    preview: "Context projection",
    config: { provider: "openai", modelId: "gpt-5.2" },
    runningRunId: undefined,
    queuedMessages: [],
    session: { getContextUsage: () => contextUsage },
  });

  assert.deepEqual(snapshot.contextUsage, contextUsage);
  assert.notEqual(snapshot.contextUsage, contextUsage);
});

test("messageText preserves Markdown newlines in array-shaped assistant content", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: markdownParts[0] },
      { type: "thinking", thinking: "Internal reasoning must not create a Markdown block." },
      { type: "text", text: markdownParts[1] },
      { type: "text", text: "" },
      { type: "text", text: markdownParts[2] },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  assert.equal(messageText(message), markdownReport);
});
