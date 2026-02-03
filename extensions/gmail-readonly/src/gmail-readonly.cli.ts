import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { GmailReadonlyPluginConfig } from "./gmail-readonly.config.js";
import { listStoredGoogleAccounts } from "./gmail-readonly.credentials.js";
import { runGoogleOAuthLogin } from "./gmail-readonly.google-oauth.js";

export function registerGmailReadonlyCli(params: {
  api: OpenClawPluginApi;
  program: Command;
  config: GmailReadonlyPluginConfig;
}) {
  const { api, program, config } = params;

  function ensureConfigured() {
    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        "[gmail-readonly] Missing OAuth config. Set " +
          'plugins.entries["gmail-readonly"].config.clientId and .clientSecret (or env OPENCLAW_GMAIL_CLIENT_ID / OPENCLAW_GMAIL_CLIENT_SECRET).',
      );
    }
  }

  const cmd = program
    .command("gmail")
    .description("Gmail + Google Calendar read-only integration (OAuth)");

  cmd
    .command("login")
    .description("Login to Google (stores refresh token locally).")
    .action(async () => {
      ensureConfigured();
      api.logger.info(
        "[gmail-readonly] Login requires opening a browser window to complete OAuth.",
      );
      await runGoogleOAuthLogin(api, config);
    });

  cmd
    .command("status")
    .description("Show configured Gmail accounts for this integration.")
    .action(async () => {
      const accounts = await listStoredGoogleAccounts(api);
      if (accounts.length === 0) {
        api.logger.info("[gmail-readonly] No accounts configured yet. Run: openclaw gmail login");
        return;
      }
      api.logger.info(`[gmail-readonly] Accounts: ${accounts.join(", ")}`);
    });
}
