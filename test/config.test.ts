import { describe, expect, it } from "vitest";
import { loadConfig, resolveEnforcement } from "../src/config.js";

describe("resolveEnforcement", () => {
  it("required always enforces regardless of secureMode/oauth", () => {
    expect(resolveEnforcement("required", undefined, false)).toEqual({ enforce: true, failClosed: false });
    expect(resolveEnforcement("required", false, false)).toEqual({ enforce: true, failClosed: false });
  });

  it("disabled never enforces", () => {
    expect(resolveEnforcement("disabled", true, true)).toEqual({ enforce: false, failClosed: false });
  });

  it("auto follows a definitive secureMode", () => {
    expect(resolveEnforcement("auto", true, true)).toEqual({ enforce: true, failClosed: false });
    expect(resolveEnforcement("auto", false, true)).toEqual({ enforce: false, failClosed: false });
  });

  it("auto fails CLOSED when secureMode is undetermined AND oauth is configured", () => {
    expect(resolveEnforcement("auto", undefined, true)).toEqual({ enforce: true, failClosed: true });
  });

  it("auto stays off when secureMode is undetermined and oauth is NOT configured (local dev)", () => {
    expect(resolveEnforcement("auto", undefined, false)).toEqual({ enforce: false, failClosed: false });
  });
});

describe("loadConfig heartbeat retry settings", () => {
  it("defaults to 30 retries at 2000ms", () => {
    const cfg = loadConfig({});
    expect(cfg.heartbeatRetries).toBe(30);
    expect(cfg.heartbeatRetryDelayMs).toBe(2000);
  });

  it("reads overrides from env", () => {
    const cfg = loadConfig({ MCP_HEARTBEAT_RETRIES: "5", MCP_HEARTBEAT_RETRY_DELAY_MS: "500" });
    expect(cfg.heartbeatRetries).toBe(5);
    expect(cfg.heartbeatRetryDelayMs).toBe(500);
  });

  it("clamps a negative retry count to at least 1", () => {
    expect(loadConfig({ MCP_HEARTBEAT_RETRIES: "-5" }).heartbeatRetries).toBe(1);
  });

  it("falls back to the default for unparseable/zero values", () => {
    expect(loadConfig({ MCP_HEARTBEAT_RETRIES: "abc" }).heartbeatRetries).toBe(30);
    expect(loadConfig({ MCP_HEARTBEAT_RETRIES: "0" }).heartbeatRetries).toBe(30);
  });
});
