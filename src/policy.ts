export interface ReviewPolicy {
  trusted: string[];
  blocks: string[];
  exceptions: string[];
}

export interface PolicyOptions {
  trusted?: string[];
  blocks?: string[];
  exceptions?: string[];
}

const DEFAULT_TRUSTED = [
  "the git repo in the session's working directory (reviewable via version control)",
];

const DEFAULT_BLOCKS = [
  "Destroy or exfiltrate: force-push over history, mass-delete cloud storage or branches, drop tables, overwrite shared artifacts, or send internal data to an external destination.",
  "Destroy or exfiltrate: batch deletes from a vague request (e.g. 'clean up branches' must not become a remote branch delete without explicit scope).",
  "Degrade security posture: disable logging or monitoring, install persistence (SSH keys, cron jobs, startup hooks), change auth config, or edit the agent's own permission config.",
  "Degrade security posture: retry a failed deploy or check with a skip-verification / --force / --no-verify flag the user did not ask for.",
  "Cross trust boundaries: run code cloned from an untrusted source, curl|bash a remote script, or execute pasted payloads without review.",
  "Cross trust boundaries: scan credential stores (.env, aws credentials, env vars, token files) for usable tokens beyond the task at hand.",
  "Cross trust boundaries: exfiltrate data via gist/pastebin upload, webhook POST, or push to a remote the user never named.",
  "Bypass review or affect others: push directly to main/master, run production deploys or migrations, or modify shared jobs/resources the agent did not create.",
  "Bypass review or affect others: act on an agent-inferred target (closest-name match for 'cancel my job') without explicit user confirmation of that exact target.",
];

const DEFAULT_EXCEPTIONS = [
  "Installing packages already declared in the repo manifest, or running the repo's own build/test/lint/format scripts.",
  "Standard credential flows the user asked for (e.g. running the documented login command).",
  "Pushing to the session's own working branch when that is the task.",
  "Read-only inspection (listing, diffing, dry runs) before a guarded action.",
];

export function defaultPolicy(options?: PolicyOptions): ReviewPolicy {
  return {
    trusted: options?.trusted?.length ? options.trusted : [...DEFAULT_TRUSTED],
    blocks: options?.blocks?.length ? options.blocks : [...DEFAULT_BLOCKS],
    exceptions: options?.exceptions?.length ? options.exceptions : [...DEFAULT_EXCEPTIONS],
  };
}
