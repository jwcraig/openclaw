import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type GoogleStoredOAuth = {
  provider: "google";
  email: string;
  createdAt: string;
  updatedAt: string;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  scope: string;
  tokenType: string;
};

function safeFileSegment(input: string) {
  const trimmed = input.trim();
  const replaced = trimmed.replaceAll(/[^\w@.+-]/g, "_");
  return replaced || "account";
}

function resolveCredentialsRoot(api: OpenClawPluginApi): string {
  const override = process.env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  const stateDir = api.runtime.state.resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "credentials");
}

export function resolveGmailReadonlyAuthDir(api: OpenClawPluginApi) {
  return path.join(resolveCredentialsRoot(api), "gmail-readonly");
}

export function resolveGmailReadonlyTokenPath(api: OpenClawPluginApi, email: string) {
  return path.join(resolveGmailReadonlyAuthDir(api), `${safeFileSegment(email)}.json`);
}

export async function listStoredGoogleAccounts(api: OpenClawPluginApi): Promise<string[]> {
  const dir = resolveGmailReadonlyAuthDir(api);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""))
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function readGoogleOAuth(
  api: OpenClawPluginApi,
  email: string,
): Promise<GoogleStoredOAuth> {
  const filePath = resolveGmailReadonlyTokenPath(api, email);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<GoogleStoredOAuth>;
  if (parsed.provider !== "google") {
    throw new Error("invalid token file (provider mismatch)");
  }
  if (!parsed.email || typeof parsed.email !== "string") {
    throw new Error("invalid token file (missing email)");
  }
  if (!parsed.refreshToken || typeof parsed.refreshToken !== "string") {
    throw new Error("invalid token file (missing refreshToken)");
  }
  if (!parsed.accessToken || typeof parsed.accessToken !== "string") {
    throw new Error("invalid token file (missing accessToken)");
  }
  if (!parsed.expiresAtMs || typeof parsed.expiresAtMs !== "number") {
    throw new Error("invalid token file (missing expiresAtMs)");
  }
  return parsed as GoogleStoredOAuth;
}

export async function writeGoogleOAuth(api: OpenClawPluginApi, oauth: GoogleStoredOAuth) {
  const dir = resolveGmailReadonlyAuthDir(api);
  await fs.mkdir(dir, { recursive: true });
  const filePath = resolveGmailReadonlyTokenPath(api, oauth.email);
  const tmpPath = `${filePath}.tmp`;
  const body = `${JSON.stringify(oauth, null, 2)}\n`;
  await fs.writeFile(tmpPath, body, { encoding: "utf8" });
  try {
    await fs.chmod(tmpPath, 0o600);
  } catch {
    // ignore
  }
  await fs.rename(tmpPath, filePath);
}
