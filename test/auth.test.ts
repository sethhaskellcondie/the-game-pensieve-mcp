import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";
import {
  createVerifier,
  extractBearer,
  missingScopes,
  protectedResourceMetadata,
  tokenScopes,
  type TokenVerifier,
} from "../src/auth.js";

const ISSUER = "http://localhost:8081/realms/pensieve";
const AUDIENCE = "http://localhost:8090/mcp";

let privateKey: KeyLike;
let psPrivateKey: KeyLike;
let verifier: TokenVerifier;
// A second verifier whose JWKS entry carries NO `alg`, so the key itself constrains nothing. Without it the
// algorithm allowlist is untestable: the main JWKS pins alg=RS256 on the key, which would reject a PS256
// token regardless of the verifier's `algorithms` option, and the test would pass for the wrong reason.
let unpinnedKeyVerifier: TokenVerifier;

interface SignOpts {
  iss?: string;
  aud?: string;
  expSecondsFromNow?: number;
  claims?: Record<string, unknown>;
  alg?: string;
  kid?: string;
  key?: KeyLike;
}

async function sign(opts: SignOpts = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + (opts.expSecondsFromNow ?? 300);
  return new SignJWT({ scope: "openid pensieve:read", email: "seth@example.com", ...opts.claims })
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "test-key" })
    .setIssuedAt(Math.min(nowSec, exp))
    .setSubject("user-123")
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setExpirationTime(exp)
    .sign(opts.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = (await exportJWK(pair.publicKey)) as JWK;
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  verifier = createVerifier({ issuer: ISSUER, audience: AUDIENCE }, createLocalJWKSet({ keys: [jwk] }));

  // WebCrypto keys are algorithm-bound, so a PS256 signature needs its own key pair. Both public keys go
  // into this second JWKS WITHOUT an `alg`, under distinct kids, so the keys themselves constrain nothing
  // and the paired tests below isolate the verifier's algorithms option as the only difference.
  const psPair = await generateKeyPair("PS256");
  psPrivateKey = psPair.privateKey;
  const psJwk = (await exportJWK(psPair.publicKey)) as JWK;
  psJwk.kid = "unpinned-ps";
  psJwk.use = "sig";
  const rsJwk = (await exportJWK(pair.publicKey)) as JWK;
  rsJwk.kid = "unpinned-rs";
  rsJwk.use = "sig";
  unpinnedKeyVerifier = createVerifier(
    { issuer: ISSUER, audience: AUDIENCE },
    createLocalJWKSet({ keys: [psJwk, rsJwk] }),
  );
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

  it("rejects a token signed with an algorithm outside the RS256 allowlist", async () => {
    // A well-formed PS256 token against a JWKS entry that pins no `alg` — so the ONLY thing that can refuse
    // it is the verifier's explicit algorithms option. Its RS256 twin below is the control.
    const psToken = await sign({ alg: "PS256", kid: "unpinned-ps", key: psPrivateKey });
    await expect(unpinnedKeyVerifier.verify(psToken)).rejects.toBeTruthy();
  });

  it("accepts RS256 against the same unpinned JWKS (the control for the test above)", async () => {
    const payload = await unpinnedKeyVerifier.verify(await sign({ kid: "unpinned-rs" }));
    expect(payload.sub).toBe("user-123");
  });
});

describe("scope claims", () => {
  it("splits the space-delimited scope claim", () => {
    expect(tokenScopes({ scope: "openid pensieve:read email" })).toEqual([
      "openid",
      "pensieve:read",
      "email",
    ]);
  });

  it("treats a missing or non-string scope claim as no scopes", () => {
    expect(tokenScopes({})).toEqual([]);
    expect(tokenScopes({ scope: ["pensieve:read"] as unknown as string })).toEqual([]);
  });

  it("reports exactly the required scopes a token does not hold", () => {
    expect(missingScopes({ scope: "openid pensieve:read" }, ["pensieve:read"])).toEqual([]);
    expect(missingScopes({ scope: "openid" }, ["pensieve:read"])).toEqual(["pensieve:read"]);
    expect(missingScopes({}, ["pensieve:read", "pensieve:write"])).toEqual([
      "pensieve:read",
      "pensieve:write",
    ]);
  });

  it("requires nothing when nothing is required", () => {
    expect(missingScopes({}, [])).toEqual([]);
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
