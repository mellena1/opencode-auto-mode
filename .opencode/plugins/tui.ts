import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

const tui: TuiPlugin = async (api, _options, _meta) => {
  api.event.on("permission.v2.asked", (_event: unknown) => {
    api.ui.toast({ variant: "info", title: "Auto-mode", message: "Reviewing permission...", duration: 2000 });
  });
};

export default { id: "opencode-auto-mode-tui", tui } satisfies TuiPluginModule;