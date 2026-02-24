import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OutlookReadonlyPluginConfig } from "./outlook-readonly.config.js";
import { listStoredMicrosoftAccounts } from "./outlook-readonly.credentials.js";
import { runMicrosoftDeviceCodeLogin } from "./outlook-readonly.oauth.js";

export function registerOutlookReadonlyCli(params: {
  api: OpenClawPluginApi;
  program: Command;
  config: OutlookReadonlyPluginConfig;
}) {
  const { api, program, config } = params;

  function ensureConfigured() {
    if (!config.clientId) {
      throw new Error(
        "[outlook-readonly] Missing OAuth config. Set " +
          'plugins.entries["outlook-readonly"].config.clientId (or env OPENCLAW_OUTLOOK_CLIENT_ID).',
      );
    }
  }

  const cmd = program
    .command("outlook")
    .description("Outlook (Microsoft 365) read-only integration via Microsoft Graph (device code)");

  cmd
    .command("login")
    .description("Login to Microsoft (stores refresh token locally; supports MFA).")
    .action(async () => {
      ensureConfigured();
      await runMicrosoftDeviceCodeLogin(api, config);
    });

  cmd
    .command("status")
    .description("Show configured Outlook accounts for this integration.")
    .action(async () => {
      const accounts = await listStoredMicrosoftAccounts(api);
      if (accounts.length === 0) {
        api.logger.info(
          "[outlook-readonly] No accounts configured yet. Run: openclaw outlook login",
        );
        return;
      }
      api.logger.info(`[outlook-readonly] Accounts: ${accounts.join(", ")}`);
    });
}
