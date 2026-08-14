import type { Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** Verifies a bearer token's signature, issuer, and audience. */
export interface TokenVerifier {
  verify(token: string): Promise<JWTPayload>;
}

/**
 * The signature algorithms a token may be signed with. Keycloak signs realm tokens with RS256, so this is
 * an exact allowlist rather than a preference. jose already refuses `alg: none` and will not verify an HMAC
 * token against an RSA JWK, so this pins a property that holds today instead of fixing a live hole — but it
 * pins it *explicitly*, so a future key-type change is a deliberate edit here rather than a silent widening.
 */
const ALLOWED_ALGORITHMS = ["RS256"];

/**
 * Build a verifier around a jose key resolver. Prod passes a remote JWKS
 * (see {@link createRemoteVerifier}); tests pass a local JWKS.
 */
export function createVerifier(
  cfg: { issuer: string; audience: string },
  keys: JWTVerifyGetKey,
): TokenVerifier {
  return {
    async verify(token: string): Promise<JWTPayload> {
      const { payload } = await jwtVerify(token, keys, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        algorithms: ALLOWED_ALGORITHMS,
      });
      return payload;
    },
  };
}

/** Verifier that fetches keys from a remote JWKS endpoint (with jose's built-in caching). */
export function createRemoteVerifier(cfg: {
  issuer: string;
  audience: string;
  jwksUri: string;
}): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUri));
  return createVerifier(cfg, jwks);
}

/** OAuth 2.0 Protected Resource Metadata (RFC 9728). */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

export function protectedResourceMetadata(cfg: {
  resource: string;
  issuer: string;
  scopes: string[];
}): ProtectedResourceMetadata {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: cfg.scopes,
    bearer_methods_supported: ["header"],
  };
}

/**
 * The scopes a verified token carries, from the space-delimited OAuth 2.0 `scope` claim. A token with no
 * `scope` claim (or a non-string one) holds no scopes — the caller decides whether that is fatal.
 */
export function tokenScopes(payload: JWTPayload): string[] {
  const raw = payload.scope;
  return typeof raw === "string" ? raw.split(/\s+/).filter(Boolean) : [];
}

/**
 * Which of {@code required} the token does not carry, in the order they were required (empty = satisfied).
 *
 * <p>Audience alone is not sufficient authorization. The `/mcp` audience is attached by a mapper on the
 * `pensieve:read` client scope, so before that scope was taken off the realm defaults *every* token from
 * *every* client in the realm carried the audience and passed verification here. The realm no longer grants
 * it by default, and this is the second half of that change: the scope is now checked, not merely advertised
 * in the protected-resource metadata.
 */
export function missingScopes(payload: JWTPayload, required: string[]): string[] {
  const held = new Set(tokenScopes(payload));
  return required.filter((scope) => !held.has(scope));
}

/** Extract a bearer token from the Authorization header, or null. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Send an RFC 6750 / RFC 9728 `401 Bearer` challenge, pointing the client at the
 * protected-resource metadata so it can discover the authorization server.
 */
export function sendAuthChallenge(
  res: Response,
  metadataUrl: string | undefined,
  err?: { code: string; description?: string },
): void {
  const params: string[] = [];
  if (err) {
    params.push(`error="${err.code}"`);
    if (err.description) params.push(`error_description="${sanitize(err.description)}"`);
  }
  if (metadataUrl) params.push(`resource_metadata="${metadataUrl}"`);
  res.set("WWW-Authenticate", params.length ? `Bearer ${params.join(", ")}` : "Bearer");
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: err?.description ?? "Authentication required" },
    id: null,
  });
}

/**
 * Send an RFC 6750 §3.1 `insufficient_scope` refusal: the bearer verified — signature, issuer, audience and
 * expiry are all good — but it does not carry the scopes this resource requires.
 *
 * <p>**403, not 401, and deliberately so.** 401 means "authenticate"; re-presenting the same credential
 * would fail identically, and an MCP client that reads 401 as "start the OAuth dance" would loop. 403 with
 * the `scope` parameter tells the client exactly which scopes to request on its next authorization, and
 * `resource_metadata` still points at the RFC 9728 document so it can rediscover the authorization server.
 */
export function sendInsufficientScope(
  res: Response,
  metadataUrl: string | undefined,
  required: string[],
  missing: string[],
): void {
  const description = `The access token is missing the required scope(s): ${missing.join(" ")}`;
  const params = [
    'error="insufficient_scope"',
    `error_description="${sanitize(description)}"`,
    `scope="${sanitize(required.join(" "))}"`,
  ];
  if (metadataUrl) params.push(`resource_metadata="${metadataUrl}"`);
  res.set("WWW-Authenticate", `Bearer ${params.join(", ")}`);
  res.status(403).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: description },
    id: null,
  });
}

function sanitize(value: string): string {
  // Keep the header value well-formed: no quotes, backslashes, or newlines.
  return value.replace(/["\\\r\n]/g, " ").slice(0, 200);
}
