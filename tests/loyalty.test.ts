import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { GET as loyaltyRoute } from "@/app/api/loyalty/route";
import { POST as checkoutRoute } from "@/app/api/reservations/[id]/checkout/route";
import { jobs, loyaltyOperations, payments, reservations } from "@/db/schema";
import {
  createExpireSessionHandler,
  expireSessionJobId,
  expireSessionNow,
} from "@/lib/checkout-compensation";
import { sweepExpiredHolds } from "@/lib/holds";
import { runDueJobs } from "@/lib/jobs";
import {
  createCreditPointsHandler,
  createRestorePointsHandler,
  createWelcomePointsHandler,
  creditPointsJobId,
  earnSourceId,
  getLoyaltyBalance,
  LOYALTY_SETTLE_MS,
  LoyaltyError,
  type LoyaltyGateway,
  type LoyaltyTransaction,
  maxPointsForAmount,
  pointsEarnedFor,
  recordWelcomePoints,
  resetLoyaltyState,
  restorePointsJobId,
  restoreSourceId,
  spendSourceId,
  WELCOME_POINTS,
  welcomePointsJobId,
  welcomeSourceId,
} from "@/lib/loyalty";
import { processStripeEvent } from "@/lib/payments";
import {
  createReservation,
  getReservationState,
  startCheckout,
} from "@/lib/reservations";
import type { CheckoutGateway, CheckoutSessionInput } from "@/lib/stripe";
import {
  buildTicketEmail,
  createTicketEmailHandler,
  isPermanentResendError,
  type TicketEmailMessage,
  ticketEmailJobId,
} from "@/lib/ticket-email";
import { createTestDb, duneEvent, seedTestEvents } from "./helpers";

type TestDb = ReturnType<typeof createTestDb>;

const EMAIL = "delivered+jan@resend.dev";
let keyCounter = 0;
let errorLog: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetLoyaltyState();
  errorLog = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorLog.mockRestore();
});

function createHold(db: TestDb) {
  keyCounter += 1;
  const created = createReservation(db, {
    eventId: duneEvent.id,
    seatId: "A2",
    customerName: "Jan <b>Kowalski</b>",
    email: EMAIL,
    idempotencyKey: `loyalty-key-${keyCounter}`,
  });

  if (!created.ok) {
    throw new Error(`Failed to create a test hold: ${created.reason}`);
  }

  return created;
}

function fakeStripe() {
  const created: CheckoutSessionInput[] = [];
  const expired: string[] = [];
  const sessionsByKey = new Map<string, { id: string; url: string }>();
  const gateway: CheckoutGateway = {
    async createCheckoutSession(input) {
      created.push(input);
      const existing = sessionsByKey.get(input.idempotencyKey);

      if (existing) {
        return existing;
      }

      const counter = sessionsByKey.size + 1;
      const session = {
        id: `cs_points_${counter}`,
        url: `https://checkout.stripe.test/points/${counter}`,
      };
      sessionsByKey.set(input.idempotencyKey, session);

      return session;
    },
    async expireCheckoutSession(sessionId) {
      expired.push(sessionId);
    },
  };

  return { gateway, created, expired };
}

type FakeTransaction = LoyaltyTransaction & { reason: string; points: number };

// Models Loyalty v2: every change is accepted as PENDING and settled later.
// With autoApprove the fake settles it at once; otherwise settle() does.
function fakeLoyalty(initialBalance = 1000) {
  const state = {
    balance: initialBalance,
    reads: 0,
    lookups: 0,
    adjustments: [] as Array<{ points: number; sourceId: string }>,
    transactions: [] as FakeTransaction[],
    failNext: null as LoyaltyError | null,
    autoApprove: true,
    onRead: null as ((email: string) => void) | null,
  };

  function settle(transaction: FakeTransaction) {
    if (transaction.status !== "pending") {
      return;
    }

    if (state.balance + transaction.points < 0) {
      transaction.status = "rejected";
      transaction.insufficientPoints = true;
      return;
    }

    state.balance += transaction.points;
    transaction.status = "approved";
  }

  // A change Voucherify applied although our call never got the answer.
  function record(sourceId: string, points: number) {
    const transaction: FakeTransaction = {
      id: `lctx_${state.transactions.length + 1}`,
      status: "pending",
      insufficientPoints: false,
      reason: sourceId,
      points,
    };
    state.transactions.push(transaction);
    settle(transaction);
    return transaction;
  }

  const gateway: LoyaltyGateway = {
    async getBalance(email) {
      state.reads += 1;
      state.onRead?.(email);
      return state.balance;
    },
    async adjustBalance({ points, sourceId }) {
      state.adjustments.push({ points, sourceId });

      if (state.failNext) {
        const error = state.failNext;
        state.failNext = null;
        throw error;
      }

      const transaction: FakeTransaction = {
        id: `lctx_${state.transactions.length + 1}`,
        status: "pending",
        insufficientPoints: false,
        reason: sourceId,
        points,
      };
      state.transactions.push(transaction);

      if (state.autoApprove) {
        settle(transaction);
      }

      return { ...transaction };
    },
    async findTransaction({ sourceId, transactionId }) {
      state.lookups += 1;
      const match = transactionId
        ? state.transactions.find((candidate) => candidate.id === transactionId)
        : state.transactions.find(
            (candidate) =>
              candidate.reason === sourceId && candidate.status !== "rejected",
          );

      return match ? { ...match } : null;
    },
  };

  return {
    gateway,
    state,
    record,
    settleAll: () => state.transactions.forEach(settle),
  };
}

function paidSession(
  reservationId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "cs_points_1",
    object: "checkout.session",
    payment_status: "paid",
    currency: "pln",
    amount_total: duneEvent.price - 1000,
    client_reference_id: reservationId,
    metadata: { reservationId, pointsUsed: "1000" },
    payment_intent: "pi_points_1",
    url: "https://checkout.stripe.test/points/1",
    ...overrides,
  };
}

function readReservation(db: TestDb, id: string) {
  return db.select().from(reservations).where(eq(reservations.id, id)).get();
}

function jobIds(db: TestDb): string[] {
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .all()
    .map((job) => job.id)
    .sort();
}

describe("loyalty rules", () => {
  test("caps points at half the price and earns 10 points per card złoty", () => {
    expect(maxPointsForAmount(3200)).toBe(1600);
    expect(maxPointsForAmount(4501)).toBe(2250);
    expect(pointsEarnedFor(2200)).toBe(220);
    expect(pointsEarnedFor(2299)).toBe(220);
    expect(pointsEarnedFor(99)).toBe(0);
  });

  test("caches balances and coalesces concurrent reads", async () => {
    const db = createTestDb();
    const { gateway, state } = fakeLoyalty(1000);
    let now = 0;
    const options = { now: () => now };

    const [first, second] = await Promise.all([
      getLoyaltyBalance(db, gateway, EMAIL, options),
      getLoyaltyBalance(db, gateway, ` ${EMAIL.toUpperCase()} `, options),
    ]);
    await getLoyaltyBalance(db, gateway, EMAIL, options);

    expect([first, second]).toEqual([1000, 1000]);
    expect(state.reads).toBe(1);

    now = 60_000;
    await getLoyaltyBalance(db, gateway, EMAIL, options);
    expect(state.reads).toBe(2);
  });
});

describe("checkout with points", () => {
  test("debits points and opens a session for the card amount", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const stripe = fakeStripe();
    const loyalty = fakeLoyalty(1000);

    const result = await startCheckout(db, hold.reservationId, stripe.gateway, {
      points: 1000,
      loyalty: loyalty.gateway,
    });

    expect(result).toEqual({
      ok: true,
      url: "https://checkout.stripe.test/points/1",
    });
    expect(stripe.created[0]).toMatchObject({
      amount: duneEvent.price - 1000,
      pointsUsed: 1000,
      idempotencyKey: `checkout:${hold.reservationId}:1`,
    });
    expect(loyalty.state.adjustments).toEqual([
      { points: -1000, sourceId: spendSourceId("cs_points_1") },
    ]);
    expect(db.select().from(payments).get()).toMatchObject({
      status: "pending",
      amount: duneEvent.price - 1000,
      pointsUsed: 1000,
    });
    expect(db.select().from(loyaltyOperations).get()).toMatchObject({
      id: spendSourceId("cs_points_1"),
      type: "spend",
      points: 1000,
      status: "done",
    });
    expect(getReservationState(db, hold.reservationId)).toMatchObject({
      amount: duneEvent.price,
      pointsUsed: 1000,
    });
  });

  test("refuses more than half of the price without calling anyone", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const stripe = fakeStripe();
    const loyalty = fakeLoyalty(5000);

    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: maxPointsForAmount(duneEvent.price) + 1,
        loyalty: loyalty.gateway,
      }),
    ).toEqual({ ok: false, reason: "points_limit_exceeded" });
    expect(stripe.created).toHaveLength(0);
    expect(loyalty.state.reads).toBe(0);
  });

  test("refuses more points than the balance", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const stripe = fakeStripe();
    const loyalty = fakeLoyalty(500);

    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: 600,
        loyalty: loyalty.gateway,
      }),
    ).toEqual({ ok: false, reason: "insufficient_points" });
    expect(stripe.created).toHaveLength(0);
  });

  test("needs Voucherify only when points are used", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const stripe = fakeStripe();

    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: 100,
        loyalty: null,
      }),
    ).toEqual({ ok: false, reason: "loyalty_unavailable" });
    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: 0,
        loyalty: null,
      }),
    ).toMatchObject({ ok: true });
    expect(stripe.created[0]).toMatchObject({
      amount: duneEvent.price,
      pointsUsed: 0,
    });
  });

  test("expires the session and records a failed attempt when the debit fails", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const stripe = fakeStripe();
    const loyalty = fakeLoyalty(1000);
    loyalty.state.failNext = new LoyaltyError("uncertain", "timeout");

    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: 1000,
        loyalty: loyalty.gateway,
      }),
    ).toEqual({ ok: false, reason: "loyalty_unavailable" });
    expect(stripe.expired).toEqual(["cs_points_1"]);
    const payment = db.select().from(payments).get();
    expect(payment).toMatchObject({ status: "failed", pointsUsed: 1000 });
    // A debit not visible yet may still land: the restore job settles it.
    expect(db.select().from(loyaltyOperations).get()?.status).toBe("pending");
    expect(readReservation(db, hold.reservationId)?.pointsUsed).toBe(0);
    expect(jobIds(db)).toEqual(
      [
        expireSessionJobId("cs_points_1"),
        restorePointsJobId(payment?.id ?? ""),
      ].sort(),
    );
    // The session was expired right away, so its compensation is acked.
    expect(
      db
        .select()
        .from(jobs)
        .where(eq(jobs.id, expireSessionJobId("cs_points_1")))
        .get()?.completedAt,
    ).toBeInstanceOf(Date);

    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: 1000,
        loyalty: loyalty.gateway,
      }),
    ).toMatchObject({ ok: true });
    expect(stripe.created.map((input) => input.idempotencyKey)).toEqual([
      `checkout:${hold.reservationId}:1`,
      `checkout:${hold.reservationId}:2`,
    ]);
  });

  test("refuses the checkout when Voucherify rejects the debit", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const stripe = fakeStripe();
    const loyalty = fakeLoyalty(1000);

    // The cached balance says 1000, but the points were spent elsewhere.
    await getLoyaltyBalance(db, loyalty.gateway, EMAIL);
    loyalty.state.balance = 200;

    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: 1000,
        loyalty: loyalty.gateway,
      }),
    ).toEqual({ ok: false, reason: "insufficient_points" });
    expect(stripe.expired).toEqual(["cs_points_1"]);
    expect(db.select().from(loyaltyOperations).get()).toMatchObject({
      status: "failed",
      voucherifyTransactionId: "lctx_1",
    });
    expect(db.select().from(payments).get()?.status).toBe("failed");
    // A rejected debit took nothing, so there is nothing to restore.
    expect(jobIds(db)).toEqual([expireSessionJobId("cs_points_1")]);
  });

  test("waits for a pending debit to be approved before handing out the URL", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const loyalty = fakeLoyalty(1000);
    loyalty.state.autoApprove = false;
    const lookup = loyalty.gateway.findTransaction;
    loyalty.gateway.findTransaction = async (input) => {
      loyalty.settleAll();
      return lookup(input);
    };

    expect(
      await startCheckout(db, hold.reservationId, fakeStripe().gateway, {
        points: 1000,
        loyalty: loyalty.gateway,
        approvalDelaysMs: [0, 0],
      }),
    ).toMatchObject({ ok: true });
    expect(loyalty.state.lookups).toBe(1);
    expect(db.select().from(loyaltyOperations).get()?.status).toBe("done");
  });

  test("abandons a debit that is still pending and restores it once approved", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const stripe = fakeStripe();
    const loyalty = fakeLoyalty(1000);
    loyalty.state.autoApprove = false;

    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: 1000,
        loyalty: loyalty.gateway,
        approvalDelaysMs: [0, 0],
      }),
    ).toEqual({ ok: false, reason: "loyalty_unavailable" });
    expect(stripe.expired).toEqual(["cs_points_1"]);
    expect(db.select().from(loyaltyOperations).get()).toMatchObject({
      status: "pending",
      voucherifyTransactionId: "lctx_1",
    });

    const handlers = {
      "restore-points": createRestorePointsHandler(db, () => loyalty.gateway),
    };
    const restoreJob = () =>
      db.select().from(jobs).where(eq(jobs.task, "restore-points")).get();

    await runDueJobs(db, handlers);
    expect(restoreJob()).toMatchObject({
      completedAt: null,
      totalTried: 1,
    });

    loyalty.settleAll();
    loyalty.state.autoApprove = true;
    db.update(jobs).set({ visibleAt: new Date() }).run();
    await runDueJobs(db, handlers);

    expect(restoreJob()?.completedAt).toBeInstanceOf(Date);
    expect(loyalty.state.balance).toBe(1000);
    expect(loyalty.state.adjustments).toEqual([
      { points: -1000, sourceId: spendSourceId("cs_points_1") },
      { points: 1000, sourceId: restoreSourceId("cs_points_1") },
    ]);
  });

  test("locks the split while the session is open", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const stripe = fakeStripe();
    const loyalty = fakeLoyalty(1000);
    const options = { points: 500, loyalty: loyalty.gateway };

    const first = await startCheckout(
      db,
      hold.reservationId,
      stripe.gateway,
      options,
    );

    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, options),
    ).toEqual(first);
    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        loyalty: loyalty.gateway,
      }),
    ).toEqual(first);
    expect(
      await startCheckout(db, hold.reservationId, stripe.gateway, {
        points: 0,
        loyalty: loyalty.gateway,
      }),
    ).toEqual({ ok: false, reason: "checkout_in_progress" });
    expect(loyalty.state.adjustments).toHaveLength(1);
  });
});

describe("webhook with points", () => {
  async function pointsCheckout(db: TestDb) {
    const hold = createHold(db);
    const loyalty = fakeLoyalty(1000);

    await startCheckout(db, hold.reservationId, fakeStripe().gateway, {
      points: 1000,
      loyalty: loyalty.gateway,
    });

    return { hold, loyalty };
  }

  test("validates the card amount and awards points once", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const { hold } = await pointsCheckout(db);

    expect(
      processStripeEvent(db, {
        id: "evt_full_amount",
        type: "checkout.session.completed",
        data: {
          object: paidSession(hold.reservationId, {
            amount_total: duneEvent.price,
          }),
        },
      }),
    ).toMatchObject({ ok: false, reason: "amount_mismatch" });

    const event = {
      id: "evt_points_paid",
      type: "checkout.session.completed",
      data: { object: paidSession(hold.reservationId) },
    };

    expect(processStripeEvent(db, event)).toEqual({ ok: true });
    processStripeEvent(db, { ...event, id: "evt_points_async" });

    expect(readReservation(db, hold.reservationId)).toMatchObject({
      status: "paid",
      pointsUsed: 1000,
      pointsEarned: 220,
    });
    expect(jobIds(db)).toEqual(
      [
        creditPointsJobId(hold.reservationId),
        ticketEmailJobId(hold.reservationId),
      ].sort(),
    );
  });

  test("restores points when the session expires", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const { hold } = await pointsCheckout(db);
    const payment = db.select().from(payments).get();

    processStripeEvent(db, {
      id: "evt_points_expired",
      type: "checkout.session.expired",
      data: {
        object: paidSession(hold.reservationId, {
          payment_status: "unpaid",
        }),
      },
    });

    expect(db.select().from(payments).get()?.status).toBe("expired");
    expect(readReservation(db, hold.reservationId)?.pointsUsed).toBe(0);
    expect(jobIds(db)).toEqual([restorePointsJobId(payment?.id ?? "")]);
  });

  test("refunds and restores a late payment without awarding points", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const { hold } = await pointsCheckout(db);
    const payment = db.select().from(payments).get();

    db.update(reservations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();
    processStripeEvent(db, {
      id: "evt_points_late",
      type: "checkout.session.completed",
      data: { object: paidSession(hold.reservationId) },
    });

    expect(readReservation(db, hold.reservationId)).toMatchObject({
      status: "expired",
      pointsUsed: 0,
      pointsEarned: null,
    });
    expect(jobIds(db)).toEqual(
      [`refund:${payment?.id}`, restorePointsJobId(payment?.id ?? "")].sort(),
    );
  });
});

describe("loyalty jobs", () => {
  test("restores the debited points once", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const loyalty = fakeLoyalty(1000);

    await startCheckout(db, hold.reservationId, fakeStripe().gateway, {
      points: 1000,
      loyalty: loyalty.gateway,
    });
    db.update(reservations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();

    expect(sweepExpiredHolds(db)).toBe(1);

    const handlers = {
      "restore-points": createRestorePointsHandler(db, () => loyalty.gateway),
    };
    await runDueJobs(db, handlers);
    db.update(jobs).set({ completedAt: null }).run();
    await runDueJobs(db, handlers);

    expect(loyalty.state.balance).toBe(1000);
    expect(loyalty.state.adjustments).toEqual([
      { points: -1000, sourceId: spendSourceId("cs_points_1") },
      { points: 1000, sourceId: restoreSourceId("cs_points_1") },
    ]);
  });

  test("acks a restore whose debit never happened", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const loyalty = fakeLoyalty(1000);
    loyalty.state.failNext = new LoyaltyError("not_applied", "429");

    await startCheckout(db, hold.reservationId, fakeStripe().gateway, {
      points: 1000,
      loyalty: loyalty.gateway,
    });

    const payment = db.select().from(payments).get();
    db.insert(jobs)
      .values({
        id: restorePointsJobId(payment?.id ?? ""),
        task: "restore-points",
        input: { paymentId: payment?.id ?? "" },
        visibleAt: new Date(),
      })
      .run();
    await runDueJobs(db, {
      "restore-points": createRestorePointsHandler(db, () => loyalty.gateway),
    });

    expect(loyalty.state.adjustments).toHaveLength(1);
    expect(db.select().from(jobs).get()?.completedAt).toBeInstanceOf(Date);
  });

  async function uncertainDebit(db: TestDb) {
    const hold = createHold(db);
    const loyalty = fakeLoyalty(1000);
    loyalty.state.failNext = new LoyaltyError("uncertain", "timeout");

    await startCheckout(db, hold.reservationId, fakeStripe().gateway, {
      points: 1000,
      loyalty: loyalty.gateway,
    });

    const handlers = {
      "restore-points": createRestorePointsHandler(db, () => loyalty.gateway),
    };
    const restoreJob = () =>
      db.select().from(jobs).where(eq(jobs.task, "restore-points")).get();

    return { loyalty, handlers, restoreJob };
  }

  test("waits for an uncertain debit to settle before abandoning it", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const { loyalty, handlers, restoreJob } = await uncertainDebit(db);

    await runDueJobs(db, handlers);
    expect(restoreJob()).toMatchObject({
      completedAt: null,
      totalTried: 1,
    });

    db.update(loyaltyOperations)
      .set({ updatedAt: new Date(Date.now() - LOYALTY_SETTLE_MS) })
      .run();
    db.update(jobs).set({ visibleAt: new Date() }).run();
    await runDueJobs(db, handlers);

    expect(restoreJob()?.completedAt).toBeInstanceOf(Date);
    expect(db.select().from(loyaltyOperations).get()?.status).toBe("failed");
    expect(loyalty.state.adjustments).toHaveLength(1);
  });

  test("restores an uncertain debit that Voucherify applied late", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const { loyalty, handlers, restoreJob } = await uncertainDebit(db);

    loyalty.record(spendSourceId("cs_points_1"), -1000);
    await runDueJobs(db, handlers);

    expect(restoreJob()?.completedAt).toBeInstanceOf(Date);
    expect(loyalty.state.balance).toBe(1000);
    expect(loyalty.state.adjustments.at(-1)).toEqual({
      points: 1000,
      sourceId: restoreSourceId("cs_points_1"),
    });
  });

  test("dead-letters a permanent Voucherify refusal at once", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const loyalty = fakeLoyalty(0);
    loyalty.state.failNext = new LoyaltyError("rejected", "HTTP 404");

    processStripeEvent(db, {
      id: "evt_rejected_credit",
      type: "checkout.session.completed",
      data: {
        object: paidSession(hold.reservationId, {
          amount_total: duneEvent.price,
          metadata: { reservationId: hold.reservationId },
        }),
      },
    });
    await runDueJobs(db, {
      "credit-points": createCreditPointsHandler(db, () => loyalty.gateway),
      "send-ticket-email": async () => {},
    });

    expect(
      db
        .select()
        .from(jobs)
        .where(eq(jobs.id, creditPointsJobId(hold.reservationId)))
        .get(),
    ).toMatchObject({ hasError: true, totalTried: 1, completedAt: null });
    expect(readReservation(db, hold.reservationId)?.status).toBe("paid");
  });

  test("credits earned points once and retries while Voucherify is down", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const loyalty = fakeLoyalty(0);

    processStripeEvent(db, {
      id: "evt_card_only",
      type: "checkout.session.completed",
      data: {
        object: paidSession(hold.reservationId, {
          amount_total: duneEvent.price,
          metadata: {
            reservationId: hold.reservationId,
            pointsUsed: "0",
          },
        }),
      },
    });

    const creditOnly = (gateway: LoyaltyGateway | null) => ({
      "credit-points": createCreditPointsHandler(db, () => gateway),
      "send-ticket-email": async () => {},
    });

    await runDueJobs(db, creditOnly(null));
    expect(
      db
        .select()
        .from(jobs)
        .where(eq(jobs.id, creditPointsJobId(hold.reservationId)))
        .get(),
    ).toMatchObject({ completedAt: null, totalTried: 1 });

    db.update(jobs).set({ visibleAt: new Date() }).run();
    await runDueJobs(db, creditOnly(loyalty.gateway));
    db.update(jobs).set({ completedAt: null }).run();
    await runDueJobs(db, creditOnly(loyalty.gateway));

    expect(loyalty.state.adjustments).toEqual([
      { points: 320, sourceId: earnSourceId(hold.reservationId) },
    ]);
    expect(loyalty.state.balance).toBe(320);
  });

  test("sends the ticket email with the summary and an idempotency key", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const loyalty = fakeLoyalty(1000);

    await startCheckout(db, hold.reservationId, fakeStripe().gateway, {
      points: 1000,
      loyalty: loyalty.gateway,
    });
    processStripeEvent(db, {
      id: "evt_email",
      type: "checkout.session.completed",
      data: { object: paidSession(hold.reservationId) },
    });

    const sent: TicketEmailMessage[] = [];
    await runDueJobs(db, {
      "credit-points": async () => {},
      "send-ticket-email": createTicketEmailHandler(db, () => ({
        async send(message) {
          sent.push(message);
        },
      })),
    });

    const code = readReservation(db, hold.reservationId)?.code ?? "";

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: EMAIL,
      idempotencyKey: `ticket/${hold.reservationId}`,
    });
    expect(sent[0]?.text).toContain(code);
    expect(sent[0]?.text).toContain("Zapłacono kartą: 22 zł");
    expect(sent[0]?.text).toContain("Wykorzystane punkty: 1000");
    expect(sent[0]?.text).toContain("Zdobyte punkty: 220");
    expect(sent[0]?.html).not.toContain("<b>Kowalski</b>");
    expect(sent[0]?.html).toContain("&lt;b&gt;Kowalski&lt;/b&gt;");
  });

  test("retries the email while Resend is not configured", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    processStripeEvent(db, {
      id: "evt_no_resend",
      type: "checkout.session.completed",
      data: {
        object: paidSession(hold.reservationId, {
          amount_total: duneEvent.price,
          metadata: { reservationId: hold.reservationId },
        }),
      },
    });
    await runDueJobs(db, {
      "credit-points": async () => {},
      "send-ticket-email": createTicketEmailHandler(db, () => null),
    });

    expect(
      db
        .select()
        .from(jobs)
        .where(eq(jobs.id, ticketEmailJobId(hold.reservationId)))
        .get(),
    ).toMatchObject({
      completedAt: null,
      lastError: "Resend is not configured.",
    });
    expect(readReservation(db, hold.reservationId)?.status).toBe("paid");
  });

  test("dead-letters only Resend refusals that a retry cannot fix", () => {
    expect(isPermanentResendError(422, "validation_error")).toBe(true);
    expect(isPermanentResendError(403, "invalid_access")).toBe(true);
    expect(isPermanentResendError(429, "rate_limit_exceeded")).toBe(false);
    expect(isPermanentResendError(409, "concurrent_idempotent_requests")).toBe(
      false,
    );
    expect(isPermanentResendError(500, "internal_server_error")).toBe(false);
    expect(isPermanentResendError(null, "application_error")).toBe(false);
  });

  test("builds the ticket email subject from the event", () => {
    expect(
      buildTicketEmail({
        code: "ABCD2345",
        eventTitle: "Dune",
        venue: "Sala 1",
        startsAt: new Date("2026-11-05T18:00:00.000Z"),
        seatId: "A2",
        customerName: "Jan",
        cardAmount: 3200,
        pointsUsed: 0,
        pointsEarned: 320,
      }).subject,
    ).toBe("Twój bilet: Dune (ABCD2345)");
  });
});

describe("welcome points", () => {
  function newMember(db: TestDb, loyalty: ReturnType<typeof fakeLoyalty>) {
    const enrolled = new Set<string>();
    loyalty.state.balance = 0;
    loyalty.state.onRead = (email) => {
      if (!enrolled.has(email)) {
        enrolled.add(email);
        recordWelcomePoints(db, email);
      }
    };
  }

  test("credits the welcome points once for a member the app enrolls", async () => {
    const db = createTestDb();
    const loyalty = fakeLoyalty();
    newMember(db, loyalty);
    const options = { approvalDelaysMs: [] };

    expect(await getLoyaltyBalance(db, loyalty.gateway, EMAIL, options)).toBe(
      WELCOME_POINTS,
    );
    resetLoyaltyState();
    expect(await getLoyaltyBalance(db, loyalty.gateway, EMAIL, options)).toBe(
      WELCOME_POINTS,
    );

    expect(loyalty.state.adjustments).toEqual([
      { points: WELCOME_POINTS, sourceId: welcomeSourceId(EMAIL) },
    ]);
    expect(
      db
        .select()
        .from(jobs)
        .where(eq(jobs.id, welcomePointsJobId(EMAIL)))
        .get()?.completedAt,
    ).toBeInstanceOf(Date);
  });

  test("credits the welcome points on a later read after the job was dead-lettered", async () => {
    const db = createTestDb();
    const loyalty = fakeLoyalty();
    newMember(db, loyalty);
    const handlers = {
      "credit-welcome-points": createWelcomePointsHandler(
        db,
        () => loyalty.gateway,
      ),
    };

    // The program was not ACTIVE: the read fails and the job gives up at once.
    const read = loyalty.gateway.getBalance;
    loyalty.gateway.getBalance = async (email) => {
      await read(email);
      throw new LoyaltyError("not_applied", "HTTP 423");
    };
    await getLoyaltyBalance(db, loyalty.gateway, EMAIL).catch(() => {});
    loyalty.state.failNext = new LoyaltyError("rejected", "HTTP 423");
    await runDueJobs(db, handlers);
    expect(db.select().from(jobs).get()).toMatchObject({
      hasError: true,
      totalTried: 1,
    });

    // Once the program is active, the next read credits and acks it.
    loyalty.gateway.getBalance = read;
    resetLoyaltyState();
    expect(
      await getLoyaltyBalance(db, loyalty.gateway, EMAIL, {
        approvalDelaysMs: [],
      }),
    ).toBe(WELCOME_POINTS);
    expect(db.select().from(jobs).get()).toMatchObject({ hasError: false });
    expect(db.select().from(jobs).get()?.completedAt).toBeInstanceOf(Date);
    expect(db.select().from(loyaltyOperations).get()?.status).toBe("done");
  });

  test("finishes the welcome credit in the background when Voucherify is down", async () => {
    const db = createTestDb();
    const loyalty = fakeLoyalty();
    newMember(db, loyalty);
    loyalty.state.failNext = new LoyaltyError("not_applied", "HTTP 429");

    expect(
      await getLoyaltyBalance(db, loyalty.gateway, EMAIL, {
        approvalDelaysMs: [],
      }),
    ).toBe(0);

    await runDueJobs(db, {
      "credit-welcome-points": createWelcomePointsHandler(
        db,
        () => loyalty.gateway,
      ),
    });
    db.update(jobs).set({ completedAt: null }).run();
    await runDueJobs(db, {
      "credit-welcome-points": createWelcomePointsHandler(
        db,
        () => loyalty.gateway,
      ),
    });

    expect(loyalty.state.balance).toBe(WELCOME_POINTS);
    expect(
      loyalty.state.adjustments.filter((adjustment) => adjustment.points > 0),
    ).toHaveLength(2);
    expect(db.select().from(loyaltyOperations).get()?.status).toBe("done");
  });
});

describe("checkout compensation", () => {
  test("retries a session expiry that failed in the request", async () => {
    const db = createTestDb();
    const stripe = fakeStripe();
    let down = true;
    const flaky: CheckoutGateway = {
      ...stripe.gateway,
      async expireCheckoutSession(sessionId) {
        if (down) {
          throw new Error("Stripe is down");
        }

        await stripe.gateway.expireCheckoutSession(sessionId);
      },
    };

    await expireSessionNow(db, flaky, "cs_abandoned");
    expect(jobIds(db)).toEqual([expireSessionJobId("cs_abandoned")]);

    down = false;
    await runDueJobs(db, {
      "expire-checkout-session": createExpireSessionHandler(() => flaky),
    });

    expect(stripe.expired).toEqual(["cs_abandoned"]);
    expect(db.select().from(jobs).get()?.completedAt).toBeInstanceOf(Date);
  });
});

describe("loyalty endpoints", () => {
  const originalEnv = {
    appId: process.env.VOUCHERIFY_APP_ID,
    secretKey: process.env.VOUCHERIFY_SECRET_KEY,
    programId: process.env.VOUCHERIFY_LOYALTY_PROGRAM_ID,
  };

  beforeEach(() => {
    delete process.env.VOUCHERIFY_APP_ID;
    delete process.env.VOUCHERIFY_SECRET_KEY;
    delete process.env.VOUCHERIFY_LOYALTY_PROGRAM_ID;
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "cinemaDb");

    for (const [key, value] of [
      ["VOUCHERIFY_APP_ID", originalEnv.appId],
      ["VOUCHERIFY_SECRET_KEY", originalEnv.secretKey],
      ["VOUCHERIFY_LOYALTY_PROGRAM_ID", originalEnv.programId],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("GET /api/loyalty validates the email and reports missing config", async () => {
    const invalid = await loyaltyRoute(
      new Request("http://localhost/api/loyalty?email=nope"),
    );
    const unconfigured = await loyaltyRoute(
      new Request(
        `http://localhost/api/loyalty?email=${encodeURIComponent(EMAIL)}`,
      ),
    );

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({
      code: "LOYALTY_UNAVAILABLE",
    });
  });

  test("checkout rejects malformed points", async () => {
    const db = createTestDb();
    seedTestEvents(db);
    Reflect.set(globalThis, "cinemaDb", db);
    const hold = createHold(db);

    for (const body of ['{"points":-1}', '{"points":1.5}', '{"points":"10"}']) {
      const response = await checkoutRoute(
        new Request(
          `http://localhost/api/reservations/${hold.reservationId}/checkout`,
          { method: "POST", body },
        ),
        { params: Promise.resolve({ id: hold.reservationId }) },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
  });
});
