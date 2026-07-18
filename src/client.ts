import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function stateDir(): string {
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "opencode",
  );
}

export async function makeClient() {
  const dir = stateDir();
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("service-") && f.endsWith(".json"));
  } catch {
    throw new Error("Could not read OpenCode state directory");
  }

  const { OpenCode } = await import("@opencode-ai/client");
  const { Service } = await import("@opencode-ai/client/service");

  let endpoint: Awaited<ReturnType<typeof Service.discover>> = undefined;
  for (const f of files) {
    endpoint = await Service.discover({ file: path.join(dir, f) });
    if (endpoint) break;
  }

  if (!endpoint) {
    throw new Error("Could not discover a healthy OpenCode service");
  }

  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint) ?? {},
  });

  return client as {
    permission: {
      reply: (input: {
        sessionID: string;
        requestID: string;
        reply: "once" | "always" | "reject";
        message?: string;
      }) => Promise<void>;
    };
    generate: {
      text: (input: {
        prompt: string;
        model?: { id: string; providerID: string; variant?: string } | null;
      }) => Promise<{ text: string }>;
    };
  };
}