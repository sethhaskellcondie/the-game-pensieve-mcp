import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";
import { createHttpApp, type AuthState } from "../src/httpApp.js";
import { createVerifier, protectedResourceMetadata } from "../src/auth.js";
import type { EntityKey } from "../src/entities.js";
import type { Heartbeat, PensieveApi } from "../src/apiClient.js";

const ISSUER = "http://localhost:8081/realms/pensieve";
const AUDIENCE = "http://localhost:8090/mcp";
const METADATA_URL = "http://localhost:8090/.well-known/oauth-protected-resource/mcp";

function fakeApi(): PensieveApi {
  return {
    heartbeat: async (): Promise<Heartbeat> => ({ message: "t", secureMode: true }),
    getAvailableFilters: async (k: EntityKey) => ({ type: `${k}_filters` }),
    search: async () => [],
    getCustomFields: async () => [],
    listShowcases: async () => [],
  };
}

let privateKey: KeyLike;
let secured: Server;
let open: Server;
let securedUrl: string;
let openUrl: string;

async function signValid(): Promise<string> {
  return new SignJWT({ scope: "pensieve:read" })
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .setIssuedAt()
    .setSubject("u")
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime("5m")
    .sign(privateKey);
}

function rpc(url: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = (await exportJWK(pair.publicKey)) as JWK;
  jwk.kid = "k";
  jwk.alg = "RS256";
  const verifier = createVerifier({ issuer: ISSUER, audience: AUDIENCE }, createLocalJWKSet({ keys: [jwk] }));
  const metadata = protectedResourceMetadata({ resource: AUDIENCE, issuer: ISSUER, scopes: ["pensieve:read"] });

  const securedAuth: AuthState = { enforce: true, verifier, metadata, metadataUrl: METADATA_URL };
  const openAuth: AuthState = { enforce: false, metadata, metadataUrl: METADATA_URL };

  secured = createHttpApp({ makeApi: () => fakeApi(), serverInfo: { name: "t", version: "0" }, auth: securedAuth }).listen(0);
  open = createHttpApp({ makeApi: () => fakeApi(), serverInfo: { name: "t", version: "0" }, auth: openAuth }).listen(0);
  securedUrl = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
  openUrl = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => secured.close(() => r())),
    new Promise<void>((r) => open.close(() => r())),
  ]);
});

describe("protected resource metadata (RFC 9728)", () => {
  it("serves the metadata document at the root and path-aware well-known URLs", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`${securedUrl}${path}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resource).toBe(AUDIENCE);
      expect(body.authorization_servers).toEqual([ISSUER]);
      expect(body.scopes_supported).toContain("pensieve:read");
    }
  });

  it("keeps /healthz public", async () => {
    const res = await fetch(`${securedUrl}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe("enforced /mcp", () => {
  it("challenges an unauthenticated request with 401 + WWW-Authenticate", async () => {
    const res = await rpc(securedUrl, TOOLS_LIST);
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toMatch(/^Bearer/);
    expect(wwwAuth).toContain(`resource_metadata="${METADATA_URL}"`);
  });

  it("rejects an invalid token with 401 error=\"invalid_token\"", async () => {
    const res = await rpc(securedUrl, TOOLS_LIST, "garbage.token.here");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"');
  });

  it("allows a valid token through to the MCP server", async () => {
    const res = await rpc(securedUrl, TOOLS_LIST, await signValid());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("search_systems");
  });
});

describe("non-enforced /mcp (local mode)", () => {
  it("serves tools without a token", async () => {
    const res = await rpc(openUrl, TOOLS_LIST);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("search_systems");
  });
});
