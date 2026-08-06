import { loadConfig, resolveEnforcement } from "./config.js";
import { createApiClient } from "./apiClient.js";
import { createRemoteVerifier, protectedResourceMetadata } from "./auth.js";
import { createHttpApp, type AuthState } from "./httpApp.js";
import { probeSecureMode } from "./startup.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const makeApi = (authToken?: string) => createApiClient(cfg, authToken);

  // Probe the backend to learn whether it is in secure mode (drives "auto" enforcement). Retry so a
  // sidecar that boots before the backend is ready doesn't decide enforcement from a single failed probe
  // (compose depends_on only waits for start, not readiness). Only "auto" depends on the answer, so the
  // other modes probe once (for connectivity logging) and move on.
  const secureMode = await probeSecureMode(() => makeApi().heartbeat(), {
    retries: cfg.authMode === "auto" ? cfg.heartbeatRetries : 1,
    delayMs: cfg.heartbeatRetryDelayMs,
    log: (m) => console.log(`[pensieve-mcp] ${m}`),
  });

  const oauthConfigured = Boolean(cfg.oauthIssuer && cfg.oauthJwksUri && cfg.oauthAudience);
  const { enforce, failClosed } = resolveEnforcement(cfg.authMode, secureMode, oauthConfigured);
  if (failClosed) {
    console.warn(
      "[pensieve-mcp] WARNING: backend secureMode could not be determined at startup, but OAuth is " +
        "configured — failing CLOSED (enforcing auth) rather than serving /mcp tokenless.",
    );
  }

  if (enforce && !oauthConfigured) {
    throw new Error(
      `OAuth enforcement is ON (MCP_AUTH_MODE=${cfg.authMode}` +
        (cfg.authMode === "auto" ? ", backend secureMode=true" : "") +
        ") but MCP_OAUTH_ISSUER / MCP_OAUTH_JWKS_URI / MCP_OAUTH_AUDIENCE are not all set.",
    );
  }

  let auth: AuthState = { enforce: false };
  if (oauthConfigured) {
    const metadataUrl = `${new URL(cfg.oauthAudience!).origin}/.well-known/oauth-protected-resource/mcp`;
    auth = {
      enforce,
      verifier: enforce
        ? createRemoteVerifier({
            issuer: cfg.oauthIssuer!,
            audience: cfg.oauthAudience!,
            jwksUri: cfg.oauthJwksUri!,
          })
        : undefined,
      metadata: protectedResourceMetadata({
        resource: cfg.oauthAudience!,
        issuer: cfg.oauthIssuer!,
        scopes: cfg.oauthScopes,
      }),
      metadataUrl,
    };
  }

  console.log(
    `[pensieve-mcp] OAuth enforcement: ${enforce ? "ON" : "off"}` +
      (oauthConfigured ? "" : " (no OAuth config)") +
      (enforce ? ` — issuer=${cfg.oauthIssuer} audience=${cfg.oauthAudience}` : ""),
  );
  if (secureMode && !enforce) {
    console.warn(
      `[pensieve-mcp] WARNING: backend secureMode=true but OAuth enforcement is off (MCP_AUTH_MODE=${cfg.authMode}). ` +
        "Requests are sent unauthenticated.",
    );
  }

  const app = createHttpApp({
    makeApi,
    serverInfo: { name: cfg.serverName, version: cfg.serverVersion },
    auth,
  });
  app.listen(cfg.port, () => {
    console.log(`[pensieve-mcp] Streamable HTTP MCP server listening on :${cfg.port} (POST /mcp)`);
  });
}

main().catch((err) => {
  console.error("[pensieve-mcp] fatal:", err);
  process.exit(1);
});
