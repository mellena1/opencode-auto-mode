import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, isInProject } from "./tiers.js";

describe("classify", () => {
  it("auto-allows safe read-only shell commands", () => {
    for (const command of ["ls -la", "git status", "git log --oneline", "cat README.md", "pwd"]) {
      assert.equal(classify("shell", [command]).tier, "auto-allow", command);
    }
  });

  it("auto-allows safe read-only tool actions", () => {
    for (const action of ["read", "glob", "grep", "websearch"]) {
      assert.equal(classify(action, ["anything"]).tier, "auto-allow", action);
    }
  });

  it("auto-denies catastrophic shell patterns", () => {
    for (const command of [
      "rm -rf /",
      "sudo apt install",
      "mkfs.ext4 /dev/sda1",
      "shutdown now",
      "chmod 777 secret",
    ]) {
      assert.equal(classify("shell", [command]).tier, "auto-deny", command);
    }
  });

  it("sends chained or redirected commands to review as one action", () => {
    const result = classify("shell", ["git status && rm -rf /tmp/scratch"]);
    assert.equal(result.tier, "review");
    assert.match(result.reason, /one action/);
  });

  it("sends subagent delegation to review", () => {
    for (const action of ["task", "subagent"]) {
      assert.equal(classify(action, ["do research"]).tier, "review", action);
    }
  });

  it("auto-allows in-project edits, reviews outside ones", () => {
    assert.equal(classify("edit", ["src/index.ts"], { projectDir: "/repo" }).tier, "auto-allow");
    assert.equal(classify("write", ["src/new.ts"], { projectDir: "/repo" }).tier, "auto-allow");
    const outside = classify("edit", ["/etc/passwd"], { projectDir: "/repo" });
    assert.equal(outside.tier, "review");
    assert.match(outside.reason, /outside/);
  });

  it("reviews edits when the project directory is unknown", () => {
    assert.equal(classify("edit", ["src/index.ts"]).tier, "review");
  });

  it("reviews network fetch and unknown actions", () => {
    assert.equal(classify("webfetch", ["https://example.com"]).tier, "review");
    assert.equal(classify("launch-missiles", []).tier, "review");
  });
});

describe("isInProject", () => {
  it("accepts the root, children, and relative paths", () => {
    assert.equal(isInProject("/repo", "/repo"), true);
    assert.equal(isInProject("/repo/src/a.ts", "/repo"), true);
    assert.equal(isInProject("src/a.ts", "/repo"), true);
  });

  it("rejects escapes and sibling prefixes", () => {
    assert.equal(isInProject("../etc/passwd", "/repo"), false);
    assert.equal(isInProject("/repo-other/a.ts", "/repo"), false);
    assert.equal(isInProject("/etc/passwd", "/repo"), false);
  });
});
