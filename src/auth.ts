import type { Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** Verifies a bearer token's signature, issuer, and audience. */
export interface TokenVerifier {
  verify(token: string): Promise<JWTPayload>;
}

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

function sanitize(value: string): string {
  // Keep the header value well-formed: no quotes, backslashes, or newlines.
  return value.replace(/["\\\r\n]/g, " ").slice(0, 200);
}
