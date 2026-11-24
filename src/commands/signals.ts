/** Stop-signal watcher for long-running interactive commands (`record`, `profile login`). */

import { alive } from "../engines/process.ts";

/**
 * Stops a long-running command on SIGTERM or SIGINT, or when the process that started it is gone,
 * and still saves and closes. npx does not pass SIGTERM on, so stopping an `npx webhand record` job
 * ends npx alone; its end is the signal here.
 */
export function stopSignals(): { stopped: () => boolean; release: () => void } {
  let stopped = false;
  const parent = process.ppid;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return {
    stopped: () => stopped || !alive(parent),
    release: () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    },
  };
}
