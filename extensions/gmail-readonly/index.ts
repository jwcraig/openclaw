import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createGmailReadonlyTool } from "./src/gmail-readonly-tool.js";
import { registerGmailReadonlyCli } from "./src/gmail-readonly.cli.js";
import { gmailReadonlyConfigSchema } from "./src/gmail-readonly.config.js";

const plugin = {
  id: "gmail-readonly",
  name: "Gmail (Read-only)",
  description: "Read-only Gmail + Google Calendar integration (OAuth). Calendar writes are optional and gated by config.",
  configSchema: gmailReadonlyConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = gmailReadonlyConfigSchema.parse(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info("[gmail-readonly] disabled");
      return;
    }

    api.registerTool(createGmailReadonlyTool(api, config), { optional: true });

    api.registerCli(
      ({ program }: { program: Command }) => {
        registerGmailReadonlyCli({ api, program, config });
      },
      { commands: ["gmail"] },
    );
  },
};

export default plugin;
