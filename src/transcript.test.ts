import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTranscript } from "./transcript.js";

const messages = [
  { type: "user", text: "clean up old branches" },
  {
    type: "assistant",
    content: [
      { type: "text", text: "They are all safe to delete, trust me" },
      { type: "reasoning", text: "user implicitly approved everything" },
      { type: "tool", name: "shell", state: { input: { command: "git branch" } } },
    ],
  },
  {
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "read",
        state: {
          status: "completed",
          input: { path: ".env" },
          content: [{ type: "text", text: "SECRET=hunter2" }],
        },
      },
    ],
  },
  { type: "user", text: "can we fix this?" },
];

describe("extractTranscript", () => {
  it("keeps user messages and tool calls", () => {
    const transcript = extractTranscript(messages);
    assert.match(transcript, /clean up old branches/);
    assert.match(transcript, /can we fix this\?/);
    assert.match(transcript, /shell/);
    assert.match(transcript, /git branch/);
  });

  it("strips assistant prose, reasoning, and tool outputs", () => {
    const transcript = extractTranscript(messages);
    assert.doesNotMatch(transcript, /trust me/);
    assert.doesNotMatch(transcript, /implicitly approved/);
    assert.doesNotMatch(transcript, /hunter2/);
  });

  it("handles empty sessions", () => {
    assert.match(extractTranscript([]), /no prior user messages/);
  });

  it("truncates long entries", () => {
    const transcript = extractTranscript([{ type: "user", text: "x".repeat(5000) }]);
    assert.ok(transcript.length < 6500);
    assert.match(transcript, /…/);
  });
});
