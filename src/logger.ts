import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Logger {
  log(line: string): void;
  logJSON(label: string, value: unknown): void;
}

// Logs MUST live outside the project (and outside any watched config dir like
// .opencode/). Writing inside a watched dir triggers a config reload, which
// reloads the plugin, which writes the log again — an infinite reload loop.
export function createLogger(filename: string): Logger {
  const dir = path.join(os.tmpdir(), "opencode-auto-mode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  const stamp = () => new Date().toISOString();
  const append = (line: string) => {
    fs.appendFileSync(file, `[${stamp()}] ${line}\n`);
  };
  return {
    log: append,
    logJSON: (label, value) => append(`${label}: ${JSON.stringify(value)}`),
  };
}