import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { EntityKey } from "../src/entities.js";
import type { FilterEntry, Heartbeat, PensieveApi } from "../src/apiClient.js";

function fakeApi(overrides: Partial<PensieveApi> = {}): PensieveApi {
  return {
    heartbeat: async (): Promise<Heartbeat> => ({ message: "thump thump", secureMode: false }),
    getAvailableFilters: async (k: EntityKey) => ({ type: `${k}_filters`, fields: {}, filters: {} }),
    search: async (k: EntityKey) => (k === "videoGame" ? [{ id: 1, title: "Chrono Trigger" }] : []),
    getCustomFields: async () => [],
    getCounts: async () => ({
      counts: { system: 0, toy: 0, videoGame: 0, videoGameBox: 0, boardGame: 0, boardGameBox: 0 },
      total: 0,
    }),
    listShowcases: async () => [{ slug: "seths-collection", name: "Seth's Collection" }],
    ...overrides,
  };
}

async function connect(api: PensieveApi): Promise<Client> {
  const server = createServer(api, { name: "test", version: "0" });
  const client = new Client({ name: "test-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Narrow the SDK's CallToolResult content union to text for assertions.
function firstText(result: { content: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  expect(content[0]?.type).toBe("text");
  return content[0]?.text ?? "";
}

describe("mcp server", () => {
  it("exposes exactly the read-only tool surface, each with a description", async () => {
    const client = await connect(fakeApi());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_available_filters",
      "get_collection_summary",
      "get_custom_fields",
      "list_showcases",
      "search_board_game_boxes",
      "search_board_games",
      "search_systems",
      "search_toys",
      "search_video_game_boxes",
      "search_video_games",
    ]);
    for (const tool of tools) {
      expect(tool.description && tool.description.length).toBeTruthy();
    }
  });

  it("search_video_games injects the videoGame key and returns API data", async () => {
    let calledWith: { key: EntityKey; filters: FilterEntry[] } | undefined;
    const client = await connect(
      fakeApi({
        search: async (key, filters) => {
          calledWith = { key, filters };
          return [{ id: 1, title: "Chrono Trigger" }];
        },
      }),
    );
    const result = await client.callTool({
      name: "search_video_games",
      arguments: { filters: [{ field: "title", operator: "contains", operand: "Chrono" }] },
    });
    expect(calledWith?.key).toBe("videoGame");
    expect(calledWith?.filters).toEqual([{ field: "title", operator: "contains", operand: "Chrono" }]);
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("Chrono Trigger");
  });

  it("search tools default to an empty filter list when none is supplied", async () => {
    let received: FilterEntry[] | undefined;
    const client = await connect(
      fakeApi({
        search: async (_key, filters) => {
          received = filters;
          return [];
        },
      }),
    );
    await client.callTool({ name: "search_toys", arguments: {} });
    expect(received).toEqual([]);
  });

  it("get_collection_summary returns the backend's counts endpoint result", async () => {
    const client = await connect(
      fakeApi({
        getCounts: async () => ({
          counts: { system: 1, toy: 3, videoGame: 0, videoGameBox: 0, boardGame: 0, boardGameBox: 0 },
          total: 4,
        }),
      }),
    );
    const result = await client.callTool({ name: "get_collection_summary", arguments: {} });
    const parsed = JSON.parse(firstText(result)) as { counts: Record<string, number>; total: number };
    expect(parsed.counts.toy).toBe(3);
    expect(parsed.counts.system).toBe(1);
    expect(parsed.counts.videoGame).toBe(0);
    expect(parsed.total).toBe(4);
  });

  it("surfaces backend failures as tool errors rather than throwing", async () => {
    const client = await connect(
      fakeApi({
        getAvailableFilters: async () => {
          throw new Error("boom");
        },
      }),
    );
    const result = await client.callTool({
      name: "get_available_filters",
      arguments: { entityKey: "videoGame" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result).toLowerCase()).toContain("error");
  });

  it("returns a validation error for an invalid entityKey (input schema enforced)", async () => {
    const client = await connect(fakeApi());
    const result = await client.callTool({
      name: "get_available_filters",
      arguments: { entityKey: "notAnEntity" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result).toLowerCase()).toContain("validation");
  });
});
