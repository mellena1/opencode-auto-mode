import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStage1Prompt,
  buildStage2Prompt,
  parseDecision,
  parseStage1,
  withDenySuffix,
} from "./reviewer.js";
import { defaultPolicy } from "./policy.js";

const policy = defaultPolicy();
const request = {
  action: "shell",
  resources: ["git branch -D old-feature"],
  transcript: "User messages (most recent last):\n- clean up old branches\n",
  projectDir: "/repo",
};

describe("parseDecision", () => {
  it("parses explicit verdicts case-insensitively", () => {
    assert.deepEqual(parseDecision("ALLOW: safe read"), { decision: "allow", reason: "safe read" });
    assert.deepEqual(parseDecision("deny: destructive"), { decision: "deny", reason: "destructive" });
    assert.deepEqual(parseDecision("Ask: unclear blast radius"), {
      decision: "ask",
      reason: "unclear blast radius",
    });
  });

  it("falls back to leading keywords, then escalates", () => {
    assert.equal(parseDecision("allow, looks fine").decision, "allow");
    const unclear = parseDecision("maybe, need more context");
    assert.equal(unclear.decision, "ask");
    assert.match(unclear.reason, /unclear/);
  });
});

describe("parseStage1", () => {
  it("maps BLOCK-like tokens to block and ALLOW-like to allow", () => {
    assert.equal(parseStage1("BLOCK"), "block");
    assert.equal(parseStage1("block: suspicious chain"), "block");
    assert.equal(parseStage1("ALLOW"), "allow");
  });

  it("blocks on anything unrecognized", () => {
    assert.equal(parseStage1("garbage"), "block");
    assert.equal(parseStage1(""), "block");
  });
});

describe("stage prompts", () => {
  it("stage 1 demands a single token erring toward blocking", () => {
    const prompt = buildStage1Prompt(request, policy);
    assert.match(prompt, /exactly one token/i);
    assert.match(prompt, /BLOCK or ALLOW/);
    assert.match(prompt, /err on the side of blocking/i);
  });

  it("stage 2 carries intent rules, policy, and the anti-bypass instruction", () => {
    const prompt = buildStage2Prompt(request, policy);
    assert.match(prompt, /AUTHORIZED/);
    assert.match(prompt, /ONE action/);
    assert.match(prompt, /Block rules/);
    assert.match(prompt, /do not try to route around this block/);
    assert.match(prompt, /clean up old branches/);
  });

  it("flags subagent delegation as non-user authorization", () => {
    const prompt = buildStage2Prompt({ ...request, isDelegation: true }, policy);
    assert.match(prompt, /NOT user authorization/);
  });
});

describe("withDenySuffix", () => {
  it("leaves an already-suffixed reason untouched", () => {
    const reason =
      "Exfiltration to an unnamed host. Find a safer path and do not try to route around this block.";
    assert.equal(withDenySuffix(reason), reason);
  });

  it("tolerates case and missing terminal period", () => {
    const reason = "Risky move. FIND A SAFER PATH AND DO NOT TRY TO ROUTE AROUND THIS BLOCK";
    assert.equal(withDenySuffix(reason), reason.trim());
  });

  it("appends exactly one suffix to a bare reason", () => {
    assert.equal(
      withDenySuffix("Exfiltration to an unnamed host"),
      "Exfiltration to an unnamed host. Find a safer path and do not try to route around this block.",
    );
    assert.equal(
      withDenySuffix("Exfiltration to an unnamed host."),
      "Exfiltration to an unnamed host. Find a safer path and do not try to route around this block.",
    );
  });
});
