import { getDb } from "@/db/client";
import { type JobHandlers, runDueJobs } from "./jobs";
import { createRefundHandler } from "./refunds";
import { getStripeRefundGateway } from "./stripe";

const POLL_INTERVAL_MS = 5_000;

const globalForWorker = globalThis as typeof globalThis & {
  cinemaJobWorker?: ReturnType<typeof setInterval>;
};

function jobHandlers(): JobHandlers {
  return {
    "refund-payment": createRefundHandler(getDb(), getStripeRefundGateway),
  };
}

export function startJobWorker(): void {
  // Dev-mode reloads re-run instrumentation; keep a single poller per process.
  if (globalForWorker.cinemaJobWorker) {
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await runDueJobs(getDb(), jobHandlers());
    } catch (error) {
      console.error("Background job worker tick failed:", error);
    } finally {
      running = false;
    }
  };

  globalForWorker.cinemaJobWorker = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  globalForWorker.cinemaJobWorker.unref();
}
