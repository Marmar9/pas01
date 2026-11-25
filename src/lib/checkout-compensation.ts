import type { Db } from "@/db/client";
import { completeJob, enqueueJob, type JobHandler } from "./jobs";
import type { CheckoutGateway } from "./stripe";

// Saga compensation for a Stripe Checkout Session that must never be paid:
// its points debit failed or was rolled back, or its payment row could not be
// recorded. The job makes the compensation durable; expiring the session
// right away is only the fast path.

export function expireSessionJobId(sessionId: string): string {
  return `expire-session:${sessionId}`;
}

// Called inside the transaction that abandons the attempt (outbox).
export function enqueueExpireSession(
  tx: Db,
  sessionId: string,
  now = new Date(),
): void {
  enqueueJob(
    tx,
    {
      id: expireSessionJobId(sessionId),
      task: "expire-checkout-session",
      input: { sessionId },
    },
    now,
  );
}

/**
 * Expires the session now and acks its compensation job on success. If Stripe
 * is unreachable, the job (enqueued here if the caller has not done so) keeps
 * retrying in the background.
 */
export async function expireSessionNow(
  db: Db,
  gateway: CheckoutGateway,
  sessionId: string,
): Promise<void> {
  try {
    await gateway.expireCheckoutSession(sessionId);
    completeJob(db, expireSessionJobId(sessionId));
  } catch (error) {
    console.error(
      "Failed to expire an abandoned Stripe session; retrying in the background:",
      error instanceof Error ? error.message : "unknown error",
    );
    db.transaction((tx) => enqueueExpireSession(tx, sessionId), {
      behavior: "immediate",
    });
  }
}

export function createExpireSessionHandler(
  getGateway: () => CheckoutGateway | null,
): JobHandler {
  return async (job) => {
    const gateway = getGateway();

    if (!gateway) {
      throw new Error("Stripe is not configured.");
    }

    // The gateway only expires an open session, so a retry is harmless.
    await gateway.expireCheckoutSession(job.input.sessionId);
  };
}
