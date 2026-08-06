import type { Heartbeat } from "./apiClient.js";

export interface ProbeOptions {
  /** Total number of attempts (>= 1). */
  retries: number;
  /** Delay between attempts, in milliseconds. */
  delayMs: number;
  /** Injectable sleep (defaults to setTimeout) so tests don't wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional progress logger. */
  log?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe the backend heartbeat, retrying with a fixed delay until it answers or the attempts are exhausted.
 * Returns the reported {@code secureMode}, or {@code undefined} if the backend never answered — the caller
 * decides enforcement (fail-closed) from that. Retrying at startup closes the race where the sidecar boots
 * before the backend is ready and would otherwise latch enforcement off from a single failed probe.
 */
export async function probeSecureMode(
  heartbeat: () => Promise<Heartbeat>,
  opts: ProbeOptions,
): Promise<boolean | undefined> {
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = Math.max(1, opts.retries);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const hb = await heartbeat();
      opts.log?.(`connected to API — secureMode=${hb.secureMode} ("${hb.message}")`);
      return hb.secureMode;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt < attempts) {
        opts.log?.(
          `heartbeat attempt ${attempt}/${attempts} failed (${reason}); retrying in ${opts.delayMs}ms`,
        );
        await sleep(opts.delayMs);
      } else {
        opts.log?.(`heartbeat unreachable after ${attempts} attempt(s) (${reason})`);
      }
    }
  }
  return undefined;
}
