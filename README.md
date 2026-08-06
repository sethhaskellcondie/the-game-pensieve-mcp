# The Game Pensieve — MCP Sidecar

A read-only **MCP (Model Context Protocol)** server for The Game Pensieve API. It is a **sidecar
proxy**: a separate TypeScript process that exposes MCP tools over **Streamable HTTP** and fulfills
them by calling the existing REST API over HTTP. AI hosts (Claude Desktop, Claude Code, claude.ai
connectors) connect to it to answer natural-language questions about a game collection.

The API it proxies lives in a separate repo, **the-game-pensieve-api**; references below to
`compose.yaml`, `Caddyfile`, `keycloak/`, and the realm import all point into that repo.

Status: **complete** (Phases 1–7 of the MCP rollout plan) — scaffold + transport, the
read-only tool surface, OAuth enforcement (the sidecar is an OAuth 2.0 Protected Resource), and the
backend is now an OAuth 2.0 **resource server** (Keycloak RS256), so a forwarded token is validated
end-to-end and every read is owner-scoped by the backend's Row-Level Security.

## OAuth

When enforcing, the sidecar validates the incoming `Authorization: Bearer` JWT (signature via JWKS,
`iss`, `aud`) with [`jose`](https://github.com/panva/jose), publishes **Protected Resource Metadata**
(RFC 9728) at `/.well-known/oauth-protected-resource[/mcp]`, and challenges missing/invalid tokens
with `401 + WWW-Authenticate: Bearer resource_metadata="…"`. Valid tokens are forwarded to the API,
which independently validates them and scopes the request to the token owner (Keycloak `sub` → owner
→ RLS). Audience (`aud`) is validated on both sides — the sidecar and the API — to block confused-deputy
replay even though the API is on a private network.

Enforcement is gated by `MCP_AUTH_MODE`:

| Mode | Behavior |
|---|---|
| `auto` (default) | enforce iff the backend heartbeat reports `secureMode=true` |
| `required` | always enforce (the recommended prod setting — no probe dependency) |
| `disabled` | never enforce (tokenless) |

In `auto` mode the startup heartbeat probe is **retried** (`MCP_HEARTBEAT_RETRIES` × `MCP_HEARTBEAT_RETRY_DELAY_MS`)
so a sidecar that boots before the backend is ready doesn't latch enforcement off from a single failed
probe. If the backend is still unreachable after the retries **and** OAuth is configured, the sidecar
**fails closed** (enforces) rather than serving `/mcp` tokenless.

`iss` is validated against the canonical, host-facing issuer, while keys are fetched from
`MCP_OAUTH_JWKS_URI` — the internal `keycloak:8080` URL on the compose network (in prod both are the
public `https://…` URLs). `/healthz` and the metadata endpoints stay public.

## Tools

| Tool | REST endpoint | Purpose |
|---|---|---|
| `get_available_filters(entityKey)` | `GET /v1/filters/{key}` | Valid fields + operators for an entity |
| `search_systems` / `search_toys` / `search_video_games` / `search_video_game_boxes` / `search_board_games` / `search_board_game_boxes` `(filters?)` | `POST /v1/{entity}/function/search` | Filtered search; the entity `key` is injected automatically |
| `get_custom_fields(entityKey?)` | `GET /v1/custom_fields[/entity/{key}]` | Custom field definitions |
| `get_collection_summary()` | `GET /v1/function/counts` | Item counts per entity + total (computed server-side, no row transfer) |
| `list_showcases()` | `GET /v1/showcases` | Public showcases (slug + name) |

All tools are read-only. Filters are `{ field, operator, operand }` objects; call
`get_available_filters` first to learn the valid combinations. An empty/omitted filter list returns
everything.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `API_BASE_URL` | `http://localhost:8080/v1` | Backend base URL incl. `/v1` (compose: `http://backend:8080/v1`) |
| `PORT` | `3000` | Port the `/mcp` endpoint listens on |
| `API_TIMEOUT_MS` | `15000` | Per-request timeout to the backend |
| `MCP_AUTH_MODE` | `auto` | `auto` \| `required` \| `disabled` (see OAuth section) |
| `MCP_OAUTH_ISSUER` | — | Expected token `iss` (canonical, host-facing) |
| `MCP_OAUTH_JWKS_URI` | — | JWKS URL for verification (compose: `http://keycloak:8080/...`) |
| `MCP_OAUTH_AUDIENCE` | — | Expected token `aud` (the `/mcp` resource URL) |
| `MCP_OAUTH_SCOPES` | `pensieve:read` | Scopes advertised in protected-resource metadata |
| `MCP_HEARTBEAT_RETRIES` | `30` | `auto` mode: startup heartbeat probe attempts before giving up |
| `MCP_HEARTBEAT_RETRY_DELAY_MS` | `2000` | Delay between heartbeat probe attempts |

## Develop

```bash
npm install
npm run dev        # tsx watch, reads .env-style vars from the environment
npm test           # vitest (hermetic; no backend needed)
npm run typecheck
npm run build && npm start
```

On startup the server probes `GET /v1/heartbeat` and logs the backend's `secureMode`.

## Connect a host

### Local (tokenless)

Bring up the API in permit-all mode (default `local`/`docker` profile) — no auth, the full read
surface is open:

```bash
API_BASE_URL=http://localhost:8080/v1 PORT=8090 npm start
npx @modelcontextprotocol/inspector             # point it at http://localhost:8090/mcp
# or register with a host (no token needed):
claude mcp add --transport http pensieve http://localhost:8090/mcp
```

### Secured (OAuth 2.1)

When the backend runs the `secured` profile the sidecar enforces OAuth. A host discovers the
authorization server from the sidecar's protected-resource metadata and runs the standard OAuth flow
(DCR + authorization-code + PKCE) against Keycloak; each user only sees their own collection.

- **Claude Code** — `claude mcp add --transport http pensieve https://<MCP_DOMAIN>/mcp` (locally,
  `http://localhost:8090/mcp` against the secured dev stack). On first use the CLI opens the browser
  to Keycloak to authorize; unauthenticated calls are challenged with `401 + WWW-Authenticate`.
- **claude.ai / Claude Desktop connectors** — add a **Custom Connector** with the remote MCP URL
  `https://<MCP_DOMAIN>/mcp`. The client reads `/.well-known/oauth-protected-resource`, registers via
  DCR, and completes the PKCE login against Keycloak. (For remote hosts, pre-registering a client in
  Keycloak is more reliable than anonymous DCR — see `keycloak/README.md` in the API repo.)
- **MCP Inspector** — point it at the `/mcp` URL; it will prompt for the OAuth flow.

Every tool call is owner-scoped by the backend: a lapsed/guest caller gets the same `402`/`403`
capability responses (surfaced as MCP `isError` results) it would from the REST API — MCP reads
inherit the exact same authorization as the web app (RLS + the capability matrix), never more.

## Docker / Compose

The compose stack lives in the **API repo**, which consumes this sidecar as a published image
(`sethcondie/the-game-pensieve-mcp:latest`) — the same way it consumes the front end. Build and push
from this repo:

```bash
docker build -t sethcondie/the-game-pensieve-mcp:latest .
# multiplatform build-and-push commands: documentation/DevDocumentation.md in the API repo
```

Then, from the API repo:

```bash
docker compose up -d backend mcp
# MCP endpoint: http://localhost:8090/mcp
```

To iterate locally without a rebuild each time, run `npm run dev` on the host against the compose
backend (`API_BASE_URL=http://localhost:8080/v1 PORT=8090`) instead of the `mcp` service.

In production (`compose.production.yaml` in the API repo) the sidecar has **no public ports** — Caddy
fronts it at `https://<MCP_DOMAIN>/mcp` and terminates TLS. There it runs `MCP_AUTH_MODE=required`
with the public issuer/audience URLs. See that repo's `Caddyfile` + `.env.production.example`.

## Transport notes

Streamable HTTP, **stateless**: each `POST /mcp` spins up a fresh server + transport. `GET`/`DELETE`
on `/mcp` return `405` (no server-initiated streams or sessions). `GET /healthz` is a liveness probe.
