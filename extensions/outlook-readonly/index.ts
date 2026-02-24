import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createOutlookReadonlyTool } from "./src/outlook-readonly-tool.js";
import { registerOutlookReadonlyCli } from "./src/outlook-readonly.cli.js";
import { outlookReadonlyConfigSchema } from "./src/outlook-readonly.config.js";

const plugin = {
  id: "outlook-readonly",
  name: "Outlook (Read-only)",
  description:
    "Read-only Microsoft 365 Mail + Calendar via Microsoft Graph (device code OAuth). Calendar writes are optional and gated by config.",
  configSchema: outlookReadonlyConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = outlookReadonlyConfigSchema.parse(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info("[outlook-readonly] disabled");
      return;
    }

    api.registerTool(createOutlookReadonlyTool(api, config), { optional: true });

    api.registerCli(
      ({ program }: { program: Command }) => {
        registerOutlookReadonlyCli({ api, program, config });
      },
      { commands: ["outlook"] },
    );
  },
};

export default plugin;
