import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PensieveApi } from "./apiClient.js";
import {
  extractBearer,
  sendAuthChallenge,
  type ProtectedResourceMetadata,
  type TokenVerifier,
} from "./auth.js";
import { createServer } from "./server.js";

export interface AuthState {
  /** Whether a valid bearer token is required on POST /mcp. */
  enforce: boolean;
  /** Verifies the bearer's signature/issuer/audience. Required when enforce is true. */
  verifier?: TokenVerifier;
  /** Served at the protected-resource well-known endpoints (if present). */
  metadata?: ProtectedResourceMetadata;
  /** Absolute URL of the metadata document, referenced in WWW-Authenticate. */
  metadataUrl?: string;
}

export interface HttpAppDeps {
  /** Build an API client bound to the request's bearer token (undefined in local mode). */
  makeApi: (authToken?: string) => PensieveApi;
  serverInfo: { name: string; version: string };
  auth: AuthState;
}

function methodNotAllowed(_req: Request, res: Response): void {
  res
    .status(405)
    .set("Allow", "POST")
    .json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This stateless MCP endpoint only accepts POST." },
      id: null,
    });
}

/**
 * Express app exposing the MCP server over Streamable HTTP at POST /mcp (stateless), plus:
 *  - GET /healthz — liveness probe (public)
 *  - GET /.well-known/oauth-protected-resource[/mcp] — OAuth PRM (RFC 9728), when OAuth is configured
 * When auth.enforce is true, POST /mcp requires a valid bearer token and challenges otherwise.
 */
export function createHttpApp(deps: HttpAppDeps): Express {
  const { makeApi, serverInfo, auth } = deps;
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Protected Resource Metadata (RFC 9728). Served at the root and path-aware well-known URLs so
  // clients following either convention can discover the authorization server. Always public.
  if (auth.metadata) {
    const serveMetadata = (_req: Request, res: Response) => res.json(auth.metadata);
    app.get("/.well-known/oauth-protected-resource", serveMetadata);
    app.get("/.well-known/oauth-protected-resource/mcp", serveMetadata);
  }

  app.post("/mcp", async (req, res) => {
    let bearer: string | undefined;

    if (auth.enforce) {
      const token = extractBearer(req.header("authorization"));
      if (!token) {
        sendAuthChallenge(res, auth.metadataUrl);
        return;
      }
      try {
        await auth.verifier!.verify(token);
      } catch (err) {
        sendAuthChallenge(res, auth.metadataUrl, {
          code: "invalid_token",
          description: err instanceof Error ? err.message : "Token verification failed",
        });
        return;
      }
      bearer = token;
    }

    const server = createServer(makeApi(bearer), serverInfo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[pensieve-mcp] error handling /mcp request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Streamable HTTP GET (server-initiated SSE) and DELETE (session teardown) require stateful
  // sessions, which this stateless server does not use.
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
