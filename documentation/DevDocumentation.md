# Developer Documentation — the-game-pensieve-mcp

This document is for developers working **on** the sidecar itself. For what the project is and how
to run/connect it, start with the top-level [README](../README.md).

## What this project is (in one paragraph)

A small, read-only MCP server that sits between AI hosts (Claude Desktop, Claude Code, claude.ai
connectors) and The Game Pensieve REST API. It speaks **MCP over Streamable HTTP** on one side and
plain REST over `fetch` on the other. It holds no state and no database — every tool call is
translated into one backend HTTP request, and the backend remains the single source of truth for
data *and* authorization (Row-Level Security and the capability matrix). The sidecar's only security
job is to validate the incoming bearer token and forward it.

## Repo layout

```
src/
  index.ts      Entrypoint: load config, probe backend, resolve auth enforcement, start Express
  config.ts     Env-var parsing (loadConfig) + enforcement decision logic (resolveEnforcement)
  startup.ts    probeSecureMode — retried GET /v1/heartbeat at boot
  httpApp.ts    Express app: POST /mcp, /healthz, /.well-known/oauth-protected-resource[/mcp]
  auth.ts       JWT verification (jose/JWKS), RFC 9728 metadata, 401 Bearer challenges
  server.ts     Builds a fresh McpServer instance and registers the tools
  tools.ts      The MCP tool surface: schemas (zod), descriptions, handlers
  apiClient.ts  Typed REST client for the backend; envelope unwrapping; ApiError
  entities.ts   The six entity keys + entity-key → controller-path mapping
test/           Vitest suites, one per src module (hermetic — no backend, no network)
documentation/  This file
Dockerfile      Multi-stage build → node:22-alpine runtime image
.env.example    Annotated reference for every env var
```

Everything under `dist/` is compiler output — never edit it.

## Request flow

One `POST /mcp` request, end to end:

1. `httpApp.ts` — if enforcement is on, extract the `Authorization: Bearer` token and verify it
   (signature via JWKS, `iss`, `aud`) with the `TokenVerifier` from `auth.ts`. Missing/invalid
   tokens get a `401` with a `WWW-Authenticate: Bearer resource_metadata="…"` challenge so the
   host can discover the authorization server and run the OAuth flow.
2. A **fresh** `McpServer` + `StreamableHTTPServerTransport` is created per request
   (`sessionIdGenerator: undefined` = stateless). There are no sessions and no server-initiated
   streams; `GET`/`DELETE /mcp` return `405`.
3. `server.ts` / `tools.ts` — the tool handler validates input against its zod schema, then calls
   the `PensieveApi` client that was bound to this request's bearer token.
4. `apiClient.ts` — issues the REST call with the token forwarded, a per-request timeout
   (`AbortController`), and unwraps the backend's `{ data, errors, roundTripMs }` envelope.
   Non-2xx responses throw `ApiError` (status, path, details).
5. `tools.ts` — success is returned as pretty-printed JSON text content; any `ApiError` becomes an
   MCP result with `isError: true` (so a `402`/`403` capability response from the backend surfaces
   to the model verbatim, not as a transport failure).

## Startup and the enforcement decision

`index.ts` orchestrates boot; the interesting logic lives in two pure, well-tested functions:

- **`probeSecureMode`** (`startup.ts`) — hits `GET /v1/heartbeat` up to `MCP_HEARTBEAT_RETRIES`
  times (default 30 × 2 s). Compose `depends_on` only waits for container *start*, not readiness,
  so without retries a sidecar racing the backend would decide enforcement from one failed probe.
  Returns the backend's `secureMode`, or `undefined` if it never answered.
- **`resolveEnforcement`** (`config.ts`) — maps (`MCP_AUTH_MODE`, `secureMode`, "is OAuth
  configured") → enforce / don't. The one subtle rule: in `auto` mode with an **undetermined**
  `secureMode`, if OAuth env vars are configured the sidecar **fails closed** (enforces anyway),
  because serving `/mcp` tokenless against a possibly secured backend would be a fail-open hole.
  `required` and `disabled` ignore the probe entirely.

"OAuth configured" means all three of `MCP_OAUTH_ISSUER`, `MCP_OAUTH_JWKS_URI`, and
`MCP_OAUTH_AUDIENCE` are set. Enforcement on without a full OAuth config is a fatal startup error.

Note the issuer/JWKS split: `iss` is validated against the canonical host-facing issuer URL, while
keys are fetched from `MCP_OAUTH_JWKS_URI`, which inside docker-compose is the internal
`http://keycloak:8080/...` URL. In prod both are the public `https://` URLs.

## The tool surface

All tools are defined in `tools.ts` and registered per-request. The design rules:

- **Read-only, always.** Every tool has `readOnlyHint: true`. Do not add mutating tools to this
  surface without revisiting the whole auth story (scopes, consent, capability checks).
- **The entity `key` is never model-supplied on searches.** The six `search_*` tools each hard-code
  their entity key and inject it into every filter entry, so the model can't cross entities. The
  key/path split lives in `entities.ts`: filter and custom-field endpoints use the entity *key*
  (`videoGame`), search endpoints use the pluralized *controller path* (`videoGames`).
- **Descriptions are prompts.** The tool and parameter descriptions are what the model reads to
  decide how to call things — the operator list, the "call `get_available_filters` first" guidance,
  the definitions-vs.-values note on `get_custom_fields`. Treat them as carefully as code.
- Filters are `{ field, operator, operand }` with the operand always a string; filters AND
  together; `order_by`/`order_by_desc`/`limit`/`offset` ride the same filter mechanism.

### Adding a new tool

1. Add the client method to the `PensieveApi` interface and implementation in `apiClient.ts`.
2. Register the tool in `tools.ts` (zod input schema, model-facing description, `readOnlyHint`),
   wrapping the handler body in the existing `okJson` / `errResult` pattern.
3. Add tests: a client test (mocked `fetch`) in `test/apiClient.test.ts` and a tool test through
   the in-memory server in `test/server.test.ts`.
4. Update the tool table in the README.

## Testing

```bash
npm test            # vitest run — fast, hermetic, no backend or network needed
npm run typecheck
```

There is one suite per `src` module. The patterns to follow:

- `apiClient` tests stub global `fetch`; `httpApp` tests drive the real Express app; `auth` tests
  verify JWTs against a **local** JWKS (that's why `createVerifier` takes an injected key resolver
  and `createRemoteVerifier` is the thin prod wrapper).
- `startup` tests inject `sleep` so retry loops don't run in real time.
- Anything with branching (enforcement resolution, bearer extraction, envelope/error handling)
  lives in a small pure function precisely so it can be tested without wiring. Keep it that way:
  put new logic in a pure function and keep `index.ts` as plumbing.

There is no CI in this repo yet — run `npm test` and `npm run typecheck` before committing.

## Conventions and gotchas

- **ESM throughout** (`"type": "module"`, `module: NodeNext`): relative imports must use the `.js`
  extension even in `.ts` files (`import { loadConfig } from "./config.js"`). Forgetting the
  extension compiles-then-fails at runtime.
- **Strict TypeScript** including `noUncheckedIndexedAccess` — indexing returns `T | undefined`;
  handle it rather than asserting.
- **Node ≥ 20** (`engines`) — the client uses global `fetch`/`AbortController`, no HTTP library.
  Dev runs via `tsx watch`; the Docker image runs compiled `dist/` on `node:22-alpine`.
- **No secrets in this repo.** The sidecar holds no client secret — it's a resource server, not an
  OAuth client. Keycloak realm/client setup lives in the API repo (`keycloak/`).
- **Stateless transport is load-bearing.** Building a server per request is what lets the sidecar
  scale/restart freely and bind each request's API client to that request's token. Don't introduce
  cross-request state without also revisiting sessions in the transport.
- Backend responses arrive in a `{ data, errors, roundTripMs }` envelope; `apiClient.request`
  unwraps `data` and surfaces `errors` through `ApiError.details`. Tool handlers never see the
  envelope.

## Local dev against the real stack

The docker-compose stack (backend, Postgres, Keycloak, Caddy) lives in the **the-game-pensieve-api** repo;
this repo ships only the sidecar image it consumes. The fastest iteration loop:

```bash
# In the API repo: bring up the backend (and keycloak, if testing the secured path)
docker compose up -d backend

# In this repo: run the sidecar on the host against the compose backend
API_BASE_URL=http://localhost:8080/v1 PORT=8090 npm run dev

# Poke it — MCP Inspector is a dev dependency; see "MCP Inspector" in the README
npm run inspect                        # point at http://localhost:8090/mcp
```

To exercise the OAuth path locally, run the backend's `secured` profile and set the
`MCP_OAUTH_*` vars as in `.env.example` (Keycloak on `localhost:8081`, audience
`http://localhost:8090/mcp`). `MCP_AUTH_MODE=required` is handy for forcing the secure path
regardless of what the heartbeat reports.

When you need the containerized sidecar (e.g., to test the docker-compose wiring itself), build and push
the image and use the `mcp` service from the API repo — see "Docker / Compose" in the README.

## Where the other pieces live

| Concern | Where |
|---|---|
| REST API, RLS, capability matrix, heartbeat/`secureMode` | `the-game-pensieve-api` repo |
| Compose stacks (`dockerCompose/`), Caddy, TLS | API repo |
| Keycloak realm import, client registration guidance | API repo, `keycloak/` |
| Front end | `the-game-pensieve-web-v2` repo |
| This sidecar's published image | `sethcondie/the-game-pensieve-mcp:latest` |
