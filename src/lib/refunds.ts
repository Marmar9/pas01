import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { payments } from "@/db/schema";
import { enqueueJob, type JobHandler } from "./jobs";
import type { RefundGateway } from "./stripe";

export function refundJobId(paymentId: string): string {
  return `refund:${paymentId}`;
}

export function enqueueRefund(tx: Db, paymentId: string, now = new Date()) {
  enqueueJob(
    tx,
    {
      id: refundJobId(paymentId),
      task: "refund-payment",
      input: { paymentId },
    },
    now,
  );
}

export function createRefundHandler(
  db: Db,
  getGateway: () => RefundGateway | null,
): JobHandler {
  return async (job) => {
    const paymentId = job.input.paymentId;
    const payment = db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .get();

    if (!payment) {
      throw new Error(`Payment ${paymentId} not found.`);
    }

    if (payment.status === "refunded") {
      return;
    }

    if (payment.status !== "paid" || !payment.stripePaymentIntentId) {
      throw new Error(
        `Payment ${paymentId} cannot be refunded (status ${payment.status}).`,
      );
    }

    const gateway = getGateway();

    if (!gateway) {
      throw new Error("Stripe is not configured.");
    }

    // The job id is the Stripe idempotency key: a retry after a crash between
    // the refund and the update below gets the original refund back.
    const refund = await gateway.refundPayment({
      paymentIntentId: payment.stripePaymentIntentId,
      amount: payment.amount,
      idempotencyKey: job.id,
    });

    db.update(payments)
      .set({
        status: "refunded",
        stripeRefundId: refund.id,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "paid")))
      .run();
  };
}
