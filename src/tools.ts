import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ENTITY_KEY_ENUM, type EntityKey } from "./entities.js";
import { ApiError, type FilterEntry, type PensieveApi } from "./apiClient.js";

function okJson(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] };
}

function errResult(err: unknown): CallToolResult {
  const text =
    err instanceof ApiError
      ? `API error (${err.status}) calling ${err.path}: ${JSON.stringify(err.details)}`
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text }], isError: true };
}

const filterEntrySchema = z.object({
  field: z
    .string()
    .describe("Field name to filter or sort on. Get the valid fields for this entity from get_available_filters."),
  operator: z
    .string()
    .describe(
      "Operator to apply. Valid operators depend on the field's type (see get_available_filters). " +
        "Text: equals, not_equals, contains, starts_with, ends_with. Number: equals, not_equals, greater_than, " +
        "greater_than_equal_to, less_than, less_than_equal_to. Boolean: equals. Time (created_at/updated_at): " +
        "since, before. Sorting (any field): order_by, order_by_desc. Pagination: limit, offset.",
    ),
  operand: z
    .string()
    .describe(
      'The comparison value, as a string (e.g. "Super", "3", "true"). For order_by/order_by_desc the operand is ' +
        'ignored; for limit/offset the operand is the number as a string.',
    ),
});

const SEARCH_TOOLS: { name: string; key: EntityKey; noun: string }[] = [
  { name: "search_systems", key: "system", noun: "game systems / consoles" },
  { name: "search_toys", key: "toy", noun: "toys" },
  { name: "search_video_games", key: "videoGame", noun: "video games" },
  { name: "search_video_game_boxes", key: "videoGameBox", noun: "video game boxes (physical or collection releases that hold video games)" },
  { name: "search_board_games", key: "boardGame", noun: "board games" },
  { name: "search_board_game_boxes", key: "boardGameBox", noun: "board game boxes (including expansions and stand-alone boxes)" },
];

/** Register the full read-only tool surface (Phase 2) on the given server. */
export function registerTools(server: McpServer, api: PensieveApi): void {
  for (const tool of SEARCH_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: `Search ${tool.noun}`,
        description:
          `Search the ${tool.noun} in the collection. Returns each matching item with its fields and any ` +
          `custom field values. Pass an empty or omitted filter list to return everything. Filters are AND-ed ` +
          `together. Call get_available_filters("${tool.key}") first to learn which fields and operators are valid.`,
        inputSchema: {
          filters: z
            .array(filterEntrySchema)
            .optional()
            .describe(`Filters to apply (AND-ed). Omit or pass [] to return all ${tool.noun}.`),
        },
        annotations: { title: `Search ${tool.noun}`, readOnlyHint: true, openWorldHint: true },
      },
      async ({ filters }) => {
        try {
          return okJson(await api.search(tool.key, (filters ?? []) as FilterEntry[]));
        } catch (err) {
          return errResult(err);
        }
      },
    );
  }

  server.registerTool(
    "get_available_filters",
    {
      title: "Get available filters",
      description:
        "List the valid filter fields for one entity type and, for each field, the operators that can be used " +
        "with it. Call this before a search_* tool to build correct filters. Returns { type, fields (name -> " +
        "type), filters (field -> allowed operators) }; user-defined custom fields are included.",
      inputSchema: {
        entityKey: z
          .enum(ENTITY_KEY_ENUM)
          .describe("Entity to describe: system, toy, videoGame, videoGameBox, boardGame, or boardGameBox."),
      },
      annotations: { title: "Get available filters", readOnlyHint: true },
    },
    async ({ entityKey }) => {
      try {
        return okJson(await api.getAvailableFilters(entityKey));
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "get_custom_fields",
    {
      title: "Get custom field definitions",
      description:
        "List user-defined custom field definitions (name, type, and options for dropdown/radio/progress types). " +
        "Optionally scope to a single entity type. Note: the custom field VALUES for each item are already " +
        "included inline on the results of the search_* tools; this returns the DEFINITIONS.",
      inputSchema: {
        entityKey: z
          .enum(ENTITY_KEY_ENUM)
          .optional()
          .describe("Optional entity to scope to; omit to return all custom field definitions."),
      },
      annotations: { title: "Get custom field definitions", readOnlyHint: true },
    },
    async ({ entityKey }) => {
      try {
        return okJson(await api.getCustomFields(entityKey));
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "get_collection_summary",
    {
      title: "Get collection summary",
      description:
        "Return the number of items in each of the six entity types (systems, toys, video games, video game " +
        "boxes, board games, board game boxes) plus a total. A cheap way to grasp the size and shape of the " +
        "collection before drilling in with the search_* tools.",
      inputSchema: {},
      annotations: { title: "Get collection summary", readOnlyHint: true },
    },
    async () => {
      try {
        return okJson(await api.getCounts());
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.registerTool(
    "list_showcases",
    {
      title: "List public showcases",
      description:
        "List the public showcases (published collections) available, as slug + display name. Slugs identify a " +
        "specific public collection.",
      inputSchema: {},
      annotations: { title: "List public showcases", readOnlyHint: true },
    },
    async () => {
      try {
        return okJson(await api.listShowcases());
      } catch (err) {
        return errResult(err);
      }
    },
  );
}
