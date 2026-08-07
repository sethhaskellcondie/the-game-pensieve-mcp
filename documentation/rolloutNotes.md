# Rollout Notes — Why the MCP Sidecar Is Built This Way

This document condenses the research, planning, and review notes that drove the design of this
project. It records the *reasoning* behind each choice so future questions of "why was it done this
way?" can be answered without re-deriving the context. For how to run or extend the sidecar, see
`README.md` and `documentation/DevDocumentation.md`.

---

## 1. Why build an MCP server at all

- **MCP is to AI assistants what REST is to frontends.** The project already had a REST API so any
  HTTP client could talk to the collection; an MCP server is the same contract for any AI host
  (Claude Desktop, Claude Code, claude.ai connectors, Cursor, ChatGPT). Written once, it works with
  every MCP-speaking host — no bespoke integration per assistant.
- **The key inversion from REST:** with REST, the developer writes the code that decides which
  endpoint to call. With MCP, you publish tools (name + natural-language description + JSON Schema)
  and the *model* decides which to call, in what order, with what arguments. Tool descriptions are
  documentation the model reads — writing and iterating on them is the core design skill, and the
  single highest-leverage activity is watching a real model use the tools and tuning the
  descriptions.
- **This project was an unusually good fit.** The existing filter system (the
  `POST /v1/{entity}/function/search` endpoints with a declarative `{field, operator, operand}`
  vocabulary) is already a serializable query language — exactly the shape a model needs to compose
  queries. Natural-language questions like "Which SNES games do I own that aren't in a box?" map
  directly onto filter arrays.
- **It also feeds back into the product:** once the server exists, the web frontend can gain AI
  features via the Anthropic API's MCP connector, reusing the same tool surface.

## 2. Why a sidecar proxy, not an in-process server

Two shapes were considered: MCP endpoints inside the Spring Boot app (Spring AI ships starters for
this), or a separate proxy process calling the REST API as an ordinary HTTP client. The **sidecar**
won because:

- **Decoupled lifecycles.** Tool descriptions get tuned constantly; the sidecar can iterate and
  redeploy without touching the Java app.
- **The API stays the single enforcement point.** The sidecar is deliberately thin — no business
  logic, no database access, no token minting. Every tool call becomes one normal REST request, so
  validation, the capability matrix, and tenancy behave identically for MCP and web traffic. A new
  tool can never widen access beyond what the REST API already allows the same token.
- **TypeScript with the official `@modelcontextprotocol/sdk`** was chosen because the TS SDK is the
  reference implementation and tracks the spec closest.

## 3. Transport: stateless Streamable HTTP only

- **Streamable HTTP** (not stdio) because the target is remote/multi-user use — claude.ai
  connectors and the API-side MCP connector require an HTTP endpoint, and it matches the existing
  Docker-compose deployment. stdio only serves local single-user setups.
- **Stateless by design:** each `POST /mcp` builds a fresh server+transport pair; `GET`/`DELETE
  /mcp` (stateful session features) return 405. No state means nothing to synchronize, and the
  backend remains the single source of truth.
