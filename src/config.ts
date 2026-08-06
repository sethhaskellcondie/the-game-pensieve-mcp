export type AuthMode = "auto" | "required" | "disabled";

export interface Config {
  /** Backend REST API base URL including the /v1 prefix, no trailing slash. */
  apiBaseUrl: string;
  /** Port the Streamable HTTP MCP server listens on. */
  port: number;
  /** Per-request timeout to the backend, in milliseconds. */
  requestTimeoutMs: number;
  /** MCP server identity advertised on the initialize handshake. */
  serverName: string;
  serverVersion: string;

  /**
   * OAuth enforcement mode:
   *  - "auto"     (default) enforce iff the backend heartbeat reports secureMode=true
   *  - "required" always enforce
   *  - "disabled" never enforce (tokenless)
   */
  authMode: AuthMode;
  /** Expected token issuer (canonical, host-facing). */
  oauthIssuer?: string;
  /** JWKS URL for signature verification (container-reachable). */
  oauthJwksUri?: string;
  /** Expected token audience (the canonical /mcp resource URL). */
  oauthAudience?: string;
  /** Scopes advertised in protected-resource metadata. */
  oauthScopes: string[];
  /** In "auto" mode, how many times to probe the backend heartbeat at startup before giving up. */
  heartbeatRetries: number;
  /** Delay between heartbeat probe attempts, in milliseconds. */
  heartbeatRetryDelayMs: number;
}

/**
 * Resolve enforcement including the fail-closed rule for "auto" mode when the backend's secureMode could
 * not be determined at startup (e.g. it was unreachable). Serving {@code /mcp} tokenless against a secured
 * backend is a fail-*open* hole, so when OAuth is configured we enforce anyway rather than guess "off".
 * `required`/`disabled` are absolute and ignore secureMode.
 *
 * @returns `enforce` — whether to require a bearer; `failClosed` — true when enforcement was forced on
 *          because secureMode was undetermined (for a loud startup warning).
 */
export function resolveEnforcement(
  mode: AuthMode,
  secureMode: boolean | undefined,
  oauthConfigured: boolean,
): { enforce: boolean; failClosed: boolean } {
  if (mode === "required") return { enforce: true, failClosed: false };
  if (mode === "disabled") return { enforce: false, failClosed: false };
  // auto:
  if (secureMode === true) return { enforce: true, failClosed: false };
  if (secureMode === false) return { enforce: false, failClosed: false };
  // secureMode is undetermined — fail closed iff OAuth is configured (a secured deployment).
  return oauthConfigured ? { enforce: true, failClosed: true } : { enforce: false, failClosed: false };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiBaseUrl = (env.API_BASE_URL ?? "http://localhost:8080/v1").replace(/\/+$/, "");
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  const requestTimeoutMs = Number.parseInt(env.API_TIMEOUT_MS ?? "15000", 10);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(`Invalid API_TIMEOUT_MS: ${env.API_TIMEOUT_MS}`);
  }

  const authMode = (env.MCP_AUTH_MODE ?? "auto") as AuthMode;
  if (!["auto", "required", "disabled"].includes(authMode)) {
    throw new Error(`Invalid MCP_AUTH_MODE: ${env.MCP_AUTH_MODE} (expected auto|required|disabled)`);
  }

  return {
    apiBaseUrl,
    port,
    requestTimeoutMs,
    serverName: "game-pensieve",
    serverVersion: "0.1.0",
    authMode,
    oauthIssuer: env.MCP_OAUTH_ISSUER || undefined,
    oauthJwksUri: env.MCP_OAUTH_JWKS_URI || undefined,
    oauthAudience: env.MCP_OAUTH_AUDIENCE || undefined,
    oauthScopes: (env.MCP_OAUTH_SCOPES ?? "pensieve:read").split(/[,\s]+/).filter(Boolean),
    heartbeatRetries: Math.max(1, Number.parseInt(env.MCP_HEARTBEAT_RETRIES ?? "30", 10) || 30),
    heartbeatRetryDelayMs: Math.max(0, Number.parseInt(env.MCP_HEARTBEAT_RETRY_DELAY_MS ?? "2000", 10) || 2000),
  };
}
