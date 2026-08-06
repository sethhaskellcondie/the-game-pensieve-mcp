import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";
import { createVerifier, extractBearer, protectedResourceMetadata, type TokenVerifier } from "../src/auth.js";

const ISSUER = "http://localhost:8081/realms/pensieve";
const AUDIENCE = "http://localhost:8090/mcp";

let privateKey: KeyLike;
let verifier: TokenVerifier;

interface SignOpts {
  iss?: string;
  aud?: string;
  expSecondsFromNow?: number;
  claims?: Record<string, unknown>;
}

async function sign(opts: SignOpts = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + (opts.expSecondsFromNow ?? 300);
  return new SignJWT({ scope: "openid pensieve:read", email: "seth@example.com", ...opts.claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt(Math.min(nowSec, exp))
    .setSubject("user-123")
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setExpirationTime(exp)
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = (await exportJWK(pair.publicKey)) as JWK;
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  verifier = createVerifier({ issuer: ISSUER, audience: AUDIENCE }, createLocalJWKSet({ keys: [jwk] }));
});

describe("token verifier", () => {
  it("accepts a valid token and returns its claims", async () => {
    const payload = await verifier.verify(await sign());
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(AUDIENCE);
    expect(payload.sub).toBe("user-123");
    expect(payload.email).toBe("seth@example.com");
  });

  it("rejects a token with the wrong audience", async () => {
    await expect(verifier.verify(await sign({ aud: "http://evil/mcp" }))).rejects.toBeTruthy();
  });

  it("rejects a token with the wrong issuer", async () => {
    await expect(verifier.verify(await sign({ iss: "http://evil/realms/x" }))).rejects.toBeTruthy();
  });

  it("rejects an expired token", async () => {
    await expect(verifier.verify(await sign({ expSecondsFromNow: -60 }))).rejects.toBeTruthy();
  });

  it("rejects a malformed/garbage token", async () => {
    await expect(verifier.verify("not-a-jwt")).rejects.toBeTruthy();
  });
});

describe("extractBearer", () => {
  it("parses a Bearer header case-insensitively", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearer("bearer   xyz")).toBe("xyz");
  });
  it("returns null for missing or non-bearer headers", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer("")).toBeNull();
  });
});

describe("protectedResourceMetadata", () => {
  it("builds RFC 9728 metadata", () => {
    const meta = protectedResourceMetadata({ resource: AUDIENCE, issuer: ISSUER, scopes: ["pensieve:read"] });
    expect(meta).toEqual({
      resource: AUDIENCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["pensieve:read"],
      bearer_methods_supported: ["header"],
    });
  });
});
