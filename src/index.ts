import { Plugin } from "@opencode/plugin";
import { createLogger } from "./logger.js";
import { classify } from "./tiers.js";
import { recordDecision } from "./state.js";
import { defaultPolicy, type PolicyOptions, type ReviewPolicy } from "./policy.js";
import { extractTranscript } from "./transcript.js";
import { scanResultContent, withInjectionWarning } from "./probe.js";
import {
  buildStage1Prompt,
  buildStage2Prompt,
  parseDecision,
  parseStage1,
  withDenySuffix,
  type PermissionRequest,
} from "./reviewer.js";

const REVIEW_TIMEOUT_MS = 30_000;
const CONTEXT_TIMEOUT_MS = 3_000;
const MAX_REVIEW_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;
const MAX_CONSECUTIVE_DENIALS = 3;
const MAX_TOTAL_DENIALS = 20;

type ReviewerModel = { id: string; providerID: string; variant?: string };

let reviewCounter = 0;

const denialCounts = new Map<string, { consecutive: number; total: number }>();
const projectDirCache = new Map<string, string | undefined>();

export default Plugin.define({
  id: "opencode-auto-mode",
  setup: async (ctx) => {
    const log = createLogger("events.log");
    log.log("=== plugin loaded (permission.evaluate hook) ===");

    const options = ctx.options as {
      model?: ReviewerModel;
      review?: "all" | "prompts";
    } & PolicyOptions & { allowInProjectEdits?: boolean };
    const reviewerModel = options.model;
    const reviewScope = options.review === "prompts" ? "prompts" : "all";
    const policy = defaultPolicy(options);
    const allowInProjectEdits = options.allowInProjectEdits !== false;

    const permissionRegistration = await ctx.permission.hook("evaluate", async (event) => {
      try {
        await evaluate(ctx, event, { reviewerModel, reviewScope, policy, allowInProjectEdits }, log);
      } catch (err) {
        log.logJSON("hook error", { error: String(err) });
        throw err;
      }
    });

    const toolRegistration = await ctx.tool.hook("execute.after", (event) => {
      try {
        if (event.status !== "completed") return;
        const result = event.result as { content?: unknown };
        if (result?.content === undefined) return;
        if (scanResultContent(result.content)) {
          result.content = withInjectionWarning(
            result.content as string | ReadonlyArray<{ type: string; text?: string }>,
          ) as typeof result.content;
          log.logJSON("injection warning added", { sessionID: event.sessionID, tool: event.tool });
        }
      } catch (err) {
        log.logJSON("probe error", { error: String(err) });
      }
    });

    return () => {
      void permissionRegistration.dispose();
      void toolRegistration.dispose();
      log.log("=== plugin unloaded ===");
    };
  },
});

interface EvaluateDeps {
  reviewerModel: ReviewerModel | undefined;
  reviewScope: "all" | "prompts";
  policy: ReviewPolicy;
  allowInProjectEdits: boolean;
}

async function evaluate(
  ctx: PluginContext,
  event: Evaluation,
  deps: EvaluateDeps,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const projectDir = await projectDirFor(ctx, event.sessionID, log);
  const classification = classify(event.action, event.resources, {
    projectDir: deps.allowInProjectEdits ? projectDir : undefined,
  });
  log.logJSON("classification", { ...classification, effect: event.effect });

  if (classification.tier === "auto-deny") {
    deny(event, classification.reason, log);
    return;
  }

  if (event.effect === "deny") return;

  if (classification.tier === "auto-allow") {
    event.effect = "allow";
    event.message = `auto-approved: ${classification.reason}`;
    return;
  }

  if (deps.reviewScope === "prompts" && event.effect !== "ask") return;

  await reviewWithLLM(ctx, event, deps, projectDir, log);
}

interface Evaluation {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: readonly string[];
  effect: "allow" | "deny" | "ask";
  message?: string;
}

interface PluginContext {
  generate: {
    text(input: { prompt: string; model?: ReviewerModel | null }): Promise<{ text: string }>;
  };
  session: {
    get(input: { sessionID: string }): Promise<{ location?: { directory?: string } }>;
    context(input: { sessionID: string }): Promise<unknown[]>;
  };
}

async function projectDirFor(
  ctx: PluginContext,
  sessionID: string,
  log: ReturnType<typeof createLogger>,
): Promise<string | undefined> {
  if (projectDirCache.has(sessionID)) return projectDirCache.get(sessionID);
  try {
    const info = await withTimeout(ctx.session.get({ sessionID }), CONTEXT_TIMEOUT_MS);
    const dir = info?.location?.directory;
    projectDirCache.set(sessionID, dir);
    return dir;
  } catch (err) {
    log.log(`project dir lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function transcriptFor(ctx: PluginContext, sessionID: string): Promise<string | undefined> {
  const messages = await withTimeout(ctx.session.context({ sessionID }), CONTEXT_TIMEOUT_MS);
  return extractTranscript(messages);
}

async function reviewWithLLM(
  ctx: PluginContext,
  event: Evaluation,
  deps: EvaluateDeps,
  projectDir: string | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  log.log("reviewing...");

  const reviewID = `review-${Date.now()}-${reviewCounter++}`;
  recordDecision({
    requestID: reviewID,
    sessionID: event.sessionID,
    decision: "reviewing",
    reason: "",
    at: Date.now(),
    action: event.action,
    resources: [...event.resources],
  });

  let transcript: string | undefined;
  try {
    transcript = await transcriptFor(ctx, event.sessionID);
  } catch (err) {
    log.log(`transcript lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const req: PermissionRequest = {
    action: event.action,
    resources: [...event.resources],
    agent: event.agent,
    projectDir,
    transcript,
    isDelegation: event.action === "task" || event.action === "subagent",
  };

  const stage1 = await attemptReview(ctx, buildStage1Prompt(req, deps.policy), deps.reviewerModel, log);
  if (!stage1) return escalate(event, reviewID, "auto-mode reviewer failed — please decide yourself", log);

  const triage = parseStage1(stage1.text);
  log.logJSON("stage1 triage", { triage, text: stage1.text.slice(0, 80) });
  if (triage === "allow") {
    event.effect = "allow";
    event.message = "auto-approved: fast-path triage passed";
    recordDecision({ requestID: reviewID, sessionID: event.sessionID, decision: "allow", reason: event.message, at: Date.now() });
    noteApproval(event.sessionID);
    return;
  }

  const result = await attemptReview(ctx, buildStage2Prompt(req, deps.policy), deps.reviewerModel, log);
  if (!result) return escalate(event, reviewID, "auto-mode reviewer failed — please decide yourself", log);

  log.logJSON("reviewer response", result);

  const { decision, reason } = parseDecision(result.text);
  log.log(`decision: ${decision} — ${reason}`);

  recordDecision({ requestID: reviewID, sessionID: event.sessionID, decision, reason, at: Date.now() });

  if (decision === "allow") {
    event.effect = "allow";
    event.message = reason;
    noteApproval(event.sessionID);
    return;
  }

  if (decision === "deny") {
    const backstop = denialBackstop(event.sessionID);
    if (backstop) {
      event.effect = "ask";
      event.message = backstop;
      recordDecision({ requestID: reviewID, sessionID: event.sessionID, decision: "ask", reason: backstop, at: Date.now() });
      return;
    }
    deny(event, reason, log);
    return;
  }

  noteApproval(event.sessionID);
  event.effect = "ask";
  event.message = reason;
}

function deny(event: Evaluation, reason: string, log: ReturnType<typeof createLogger>): void {
  const counts = denialCounts.get(event.sessionID) ?? { consecutive: 0, total: 0 };
  counts.consecutive += 1;
  counts.total += 1;
  denialCounts.set(event.sessionID, counts);
  log.logJSON("denial", counts);
  if (counts.consecutive >= MAX_CONSECUTIVE_DENIALS || counts.total >= MAX_TOTAL_DENIALS) {
    counts.consecutive = 0;
    event.effect = "ask";
    event.message =
      `auto-mode blocked ${counts.total} actions in this session (backstop) — please decide yourself. Last block: ${reason}`;
    return;
  }
  event.effect = "deny";
  event.message = withDenySuffix(reason);
}

function denialBackstop(sessionID: string): string | undefined {
  const counts = denialCounts.get(sessionID) ?? { consecutive: 0, total: 0 };
  counts.consecutive += 1;
  counts.total += 1;
  denialCounts.set(sessionID, counts);
  if (counts.consecutive >= MAX_CONSECUTIVE_DENIALS || counts.total >= MAX_TOTAL_DENIALS) {
    counts.consecutive = 0;
    denialCounts.set(sessionID, counts);
    return `auto-mode blocked ${counts.total} actions in this session (backstop) — please decide yourself`;
  }
  return undefined;
}

function noteApproval(sessionID: string): void {
  const counts = denialCounts.get(sessionID);
  if (counts) {
    counts.consecutive = 0;
    denialCounts.set(sessionID, counts);
  }
}

function escalate(
  event: Evaluation,
  reviewID: string,
  failReason: string,
  log: ReturnType<typeof createLogger>,
): void {
  log.log(`escalating to user: ${failReason}`);
  recordDecision({ requestID: reviewID, sessionID: event.sessionID, decision: "ask", reason: failReason, at: Date.now() });
  noteApproval(event.sessionID);
  event.effect = "ask";
  event.message = failReason;
}

async function attemptReview(
  ctx: PluginContext,
  prompt: string,
  reviewerModel: ReviewerModel | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<{ text: string } | undefined> {
  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
    try {
      // Upstream generate.text takes only { prompt, model } — no session ID /
      // headers passthrough (verified on @opencode/plugin 2.0.14), so reviews
      // run without session affinity.
      return await withTimeout(ctx.generate.text({ prompt, model: reviewerModel ?? null }), REVIEW_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.log(`review attempt ${attempt}/${MAX_REVIEW_ATTEMPTS} failed: ${msg}`);
      if (attempt < MAX_REVIEW_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  log.log("all review attempts failed — falling back to user");
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
