import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, createApiClient, type PensieveApi } from "../src/apiClient.js";
import type { Config } from "../src/config.js";

let server: http.Server;
let baseUrl: string;
let lastRequest: { method?: string; url?: string; body?: unknown };

function envelope(data: unknown) {
  return JSON.stringify({ data, errors: null, roundTripMs: 1 });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastRequest = { method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined };
      const send = (status: number, payload: string) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload);
      };
      switch (req.url) {
        case "/v1/heartbeat":
          return send(200, envelope({ message: "thump thump", secureMode: false }));
        case "/v1/videoGames/function/search":
          return send(200, envelope([{ id: 1, title: "Chrono Trigger" }]));
        case "/v1/filters/videoGame":
          return send(200, envelope({ type: "videoGame_filters", fields: { title: "text" }, filters: { title: ["equals"] } }));
        case "/v1/custom_fields":
          return send(200, envelope([{ id: 1, name: "Rating" }]));
        case "/v1/custom_fields/entity/toy":
          return send(200, envelope([{ id: 2, name: "Condition" }]));
        case "/v1/showcases":
          return send(200, envelope([{ slug: "seths-collection", name: "Seth's Collection" }]));
        case "/v1/function/counts":
          return send(200, envelope({ counts: { system: 1, toy: 3 }, total: 4 }));
        case "/v1/systems/function/search":
          return send(500, JSON.stringify({ data: null, errors: { message: "boom" } }));
        default:
          return send(404, JSON.stringify({ data: null, errors: { message: "not found" } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const baseConfig: Omit<Config, "apiBaseUrl"> = {
  port: 0,
  requestTimeoutMs: 5000,
  serverName: "test",
  serverVersion: "0",
  authMode: "disabled",
  oauthScopes: [],
  heartbeatRetries: 1,
  heartbeatRetryDelayMs: 0,
};

function client(): PensieveApi {
  return createApiClient({ ...baseConfig, apiBaseUrl: baseUrl });
}

describe("apiClient", () => {
  it("unwraps the { data } envelope for heartbeat", async () => {
    expect(await client().heartbeat()).toEqual({ message: "thump thump", secureMode: false });
  });

  it("posts search with a { filters } wrapper and injects the entity key", async () => {
    const data = await client().search("videoGame", [{ field: "title", operator: "contains", operand: "Chrono" }]);
    expect(data).toEqual([{ id: 1, title: "Chrono Trigger" }]);
    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.url).toBe("/v1/videoGames/function/search");
    expect(lastRequest.body).toEqual({
      filters: [{ key: "videoGame", field: "title", operator: "contains", operand: "Chrono" }],
    });
  });

  it("sends an empty filters array when no filters are given", async () => {
    await client().search("videoGame", []);
    expect(lastRequest.body).toEqual({ filters: [] });
  });

  it("maps the entity key to the filters and custom-fields paths", async () => {
    await client().getAvailableFilters("videoGame");
    expect(lastRequest.url).toBe("/v1/filters/videoGame");

    await client().getCustomFields("toy");
    expect(lastRequest.url).toBe("/v1/custom_fields/entity/toy");

    await client().getCustomFields();
    expect(lastRequest.url).toBe("/v1/custom_fields");
  });

  it("fetches collection counts from the counts endpoint", async () => {
    expect(await client().getCounts()).toEqual({ counts: { system: 1, toy: 3 }, total: 4 });
    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toBe("/v1/function/counts");
  });

  it("throws ApiError with status and details on a non-2xx response", async () => {
    await expect(client().search("system", [])).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      details: { message: "boom" },
    });
  });

  it("throws ApiError with status 0 on a transport failure", async () => {
    const cfg: Config = { ...baseConfig, apiBaseUrl: "http://127.0.0.1:1/v1", requestTimeoutMs: 500 };
    await expect(createApiClient(cfg).heartbeat()).rejects.toBeInstanceOf(ApiError);
  });
});
