import { getDb } from "@/db/client";
import { sweepExpiredHolds } from "./holds";
import { type JobHandlers, runDueJobs } from "./jobs";
import {
  createCreditPointsHandler,
  createRestorePointsHandler,
} from "./loyalty";
import { createRefundHandler } from "./refunds";
import { getStripeRefundGateway } from "./stripe";
import { createTicketEmailHandler, getResendGateway } from "./ticket-email";
import { getVoucherifyGateway } from "./voucherify";

const POLL_INTERVAL_MS = 5_000;

const globalForWorker = globalThis as typeof globalThis & {
  cinemaJobWorker?: ReturnType<typeof setInterval>;
};

function jobHandlers(): JobHandlers {
  return {
    "refund-payment": createRefundHandler(getDb(), getStripeRefundGateway),
    "credit-points": createCreditPointsHandler(getDb(), getVoucherifyGateway),
    "restore-points": createRestorePointsHandler(getDb(), getVoucherifyGateway),
    "send-ticket-email": createTicketEmailHandler(getDb(), getResendGateway),
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
      try {
        sweepExpiredHolds(getDb());
      } catch (error) {
        // A failing sweep must not stop the job queue.
        console.error("Expired hold sweep failed:", error);
      }

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
