import { describe, expect, it, vi } from "vitest";
import { probeSecureMode } from "../src/startup.js";
import type { Heartbeat } from "../src/apiClient.js";

const noSleep = async (): Promise<void> => {};

describe("probeSecureMode", () => {
  it("returns secureMode on the first successful probe", async () => {
    const heartbeat = vi.fn(async (): Promise<Heartbeat> => ({ message: "ok", secureMode: true }));
    const result = await probeSecureMode(heartbeat, { retries: 5, delayMs: 10, sleep: noSleep });
    expect(result).toBe(true);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("retries until the backend answers, then returns its secureMode", async () => {
    let calls = 0;
    const heartbeat = vi.fn(async (): Promise<Heartbeat> => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return { message: "up", secureMode: false };
    });
    const result = await probeSecureMode(heartbeat, { retries: 5, delayMs: 10, sleep: noSleep });
    expect(result).toBe(false);
    expect(heartbeat).toHaveBeenCalledTimes(3);
  });

  it("returns undefined after exhausting all attempts", async () => {
    const heartbeat = vi.fn(async (): Promise<Heartbeat> => {
      throw new Error("still down");
    });
    const result = await probeSecureMode(heartbeat, { retries: 4, delayMs: 10, sleep: noSleep });
    expect(result).toBeUndefined();
    expect(heartbeat).toHaveBeenCalledTimes(4);
  });

  it("sleeps between attempts but not after the last one", async () => {
    const sleep = vi.fn(async (): Promise<void> => {});
    const heartbeat = vi.fn(async (): Promise<Heartbeat> => {
      throw new Error("down");
    });
    await probeSecureMode(heartbeat, { retries: 3, delayMs: 10, sleep });
    // 3 attempts → sleep after attempts 1 and 2, not after 3.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
