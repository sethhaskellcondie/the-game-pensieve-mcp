A small, read-only MCP (Model Context Protocol) server that sits between AI hosts and The Game
Pensieve REST API. It speaks MCP over stateless Streamable HTTP on one side and plain REST
(`fetch`) on the other. It holds no state and no database — every tool call becomes one backend
HTTP request, and the backend stays the single source of truth for data and authorization (RLS +
capability matrix). The sidecar's only security job is validating the incoming bearer JWT and
forwarding it.

The REST API, docker-compose stacks, Caddy, and Keycloak setup all live in the sibling
`the-game-pensieve-api` repo; the front end is `the-game-pensieve-web-v2`. This repo ships only the
sidecar (published image `sethcondie/the-game-pensieve-mcp:latest`).

Deeper docs: `README.md` (running, OAuth modes, connecting hosts) and
`documentation/DevDocumentation.md` (request flow, testing patterns, adding a tool).

Files in the /localFiles directory are temporary files, never write comments that reference files stored here.
