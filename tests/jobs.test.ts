import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs } from "@/db/schema";
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  JOB_LEASE_MS,
  MAX_JOB_ATTEMPTS,
  retryDelayMs,
  runDueJobs,
} from "@/lib/jobs";
import { createTestDb } from "./helpers";

const start = new Date("2026-11-04T10:00:00.000Z");

function at(ms: number): Date {
  return new Date(start.getTime() + ms);
}

function enqueueRefundJob(db: ReturnType<typeof createTestDb>, id = "job-1") {
  enqueueJob(
    db,
    { id, task: "refund-payment", input: { paymentId: "pay-1" } },
    start,
  );
}

function readJob(db: ReturnType<typeof createTestDb>, id = "job-1") {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

describe("job queue", () => {
  test("enqueueing the same job id twice keeps a single job", () => {
    const db = createTestDb();

    enqueueRefundJob(db);
    enqueueRefundJob(db);

    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  test("hides a claimed job until its lease expires", () => {
    const db = createTestDb();
    enqueueRefundJob(db);

    const claimed = claimJob(db, start);

    expect(claimed?.id).toBe("job-1");
    expect(claimed?.totalTried).toBe(1);
    expect(claimJob(db, at(JOB_LEASE_MS - 1))).toBeNull();

    // The worker died without acking: the job comes back after the lease.
    expect(claimJob(db, at(JOB_LEASE_MS))?.totalTried).toBe(2);
  });

  test("never hands out a completed job again", () => {
    const db = createTestDb();
    enqueueRefundJob(db);

    const claimed = claimJob(db, start);
    completeJob(db, claimed?.id ?? "", start);

    expect(readJob(db)?.completedAt).toEqual(start);
    expect(claimJob(db, at(24 * 60 * 60 * 1000))).toBeNull();
  });

  test("retries a failed job with exponential backoff", () => {
    const db = createTestDb();
    enqueueRefundJob(db);

    const claimed = claimJob(db, start);

    if (!claimed) {
      throw new Error("expected a job");
    }

    failJob(db, claimed, new Error("Stripe timeout"), start);

    expect(readJob(db)).toMatchObject({
      visibleAt: at(retryDelayMs(1)),
      lastError: "Stripe timeout",
      hasError: false,
    });
    expect(retryDelayMs(1)).toBe(10_000);
    expect(retryDelayMs(10)).toBe(300_000);
    expect(claimJob(db, at(retryDelayMs(1) - 1))).toBeNull();
    expect(claimJob(db, at(retryDelayMs(1)))?.totalTried).toBe(2);
  });

  test("moves a job to the dead letter queue after the attempt limit", () => {
    const db = createTestDb();
    enqueueRefundJob(db);
    let now = start;

    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt += 1) {
      const claimed = claimJob(db, now);

      expect(claimed?.totalTried).toBe(attempt);

      if (!claimed) {
        throw new Error("expected a job");
      }

      failJob(db, claimed, new Error("always fails"), now);
      now = at(attempt * 10 * 60 * 1000);
    }

    expect(readJob(db)).toMatchObject({
      hasError: true,
      lastError: "always fails",
    });
    expect(claimJob(db, at(24 * 60 * 60 * 1000))).toBeNull();
  });

  test("runDueJobs acks successful jobs and retries failing ones", async () => {
    const db = createTestDb();
    enqueueRefundJob(db, "job-ok");
    enqueueRefundJob(db, "job-bad");
    const handled: string[] = [];

    const processed = await runDueJobs(
      db,
      {
        "refund-payment": async (job) => {
          handled.push(job.id);

          if (job.id === "job-bad") {
            throw new Error("boom");
          }
        },
      },
      () => start,
    );

    expect(processed).toBe(2);
    expect(handled.sort()).toEqual(["job-bad", "job-ok"]);
    expect(readJob(db, "job-ok")?.completedAt).toEqual(start);
    expect(readJob(db, "job-bad")).toMatchObject({
      completedAt: null,
      lastError: "boom",
      visibleAt: at(retryDelayMs(1)),
    });
  });

  test("runDueJobs fails a job whose task has no handler", async () => {
    const db = createTestDb();
    enqueueRefundJob(db);

    await runDueJobs(db, {}, () => start);

    expect(readJob(db)?.lastError).toContain("No handler");
    expect(readJob(db)?.completedAt).toBeNull();
  });
});
