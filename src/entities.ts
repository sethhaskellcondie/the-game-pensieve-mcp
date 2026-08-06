/**
 * The six collection entity keys (from the backend's `Keychain`). These keys are used
 * verbatim in filter payloads and in the `/v1/filters/{key}` and
 * `/v1/custom_fields/entity/{key}` paths.
 */
export const ENTITY_KEYS = [
  "system",
  "toy",
  "videoGame",
  "videoGameBox",
  "boardGame",
  "boardGameBox",
] as const;

export type EntityKey = (typeof ENTITY_KEYS)[number];

/** A writable copy for `z.enum(...)`, which does not accept a `readonly` tuple. */
export const ENTITY_KEY_ENUM: [EntityKey, ...EntityKey[]] = [...ENTITY_KEYS];

/**
 * Search endpoints live under the pluralized controller path (e.g. `/v1/videoGames/...`),
 * which differs from the entity key (`videoGame`). Filters and custom fields use the key.
 */
export const SEARCH_PATHS: Record<EntityKey, string> = {
  system: "systems",
  toy: "toys",
  videoGame: "videoGames",
  videoGameBox: "videoGameBoxes",
  boardGame: "boardGames",
  boardGameBox: "boardGameBoxes",
};

export function isEntityKey(value: string): value is EntityKey {
  return (ENTITY_KEYS as readonly string[]).includes(value);
}
