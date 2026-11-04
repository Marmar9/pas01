import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db/client";
import { type JobRow, type JobTask, jobs } from "@/db/schema";

export const MAX_JOB_ATTEMPTS = 5;
// A claimed job stays hidden this long; if the worker dies mid-job, the job
// becomes visible again and is retried (at-least-once delivery).
export const JOB_LEASE_MS = 60_000;
const MAX_JOBS_PER_RUN = 50;

export type JobHandler = (job: JobRow) => Promise<void>;
export type JobHandlers = Partial<Record<JobTask, JobHandler>>;

export function retryDelayMs(totalTried: number): number {
  return Math.min(300, 2 ** totalTried * 5) * 1000;
}

// Called inside the caller's transaction so the job commits together with the
// data change that requires it (outbox). A fixed id makes enqueueing
// idempotent: the same job is never queued twice.
export function enqueueJob(
  tx: Db,
  job: { id: string; task: JobTask; input: Record<string, string> },
  now = new Date(),
): void {
  tx.insert(jobs)
    .values({ ...job, visibleAt: now, createdAt: now })
    .onConflictDoNothing()
    .run();
}

export function claimJob(db: Db, now = new Date()): JobRow | null {
  return db.transaction(
    (tx) => {
      const job = tx
        .select()
        .from(jobs)
        .where(
          and(
            isNull(jobs.completedAt),
            eq(jobs.hasError, false),
            lte(jobs.visibleAt, now),
          ),
        )
        .orderBy(asc(jobs.visibleAt))
        .get();

      if (!job) {
        return null;
      }

      return (
        tx
          .update(jobs)
          .set({
            visibleAt: new Date(now.getTime() + JOB_LEASE_MS),
            totalTried: job.totalTried + 1,
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.totalTried, job.totalTried)))
          .returning()
          .get() ?? null
      );
    },
    { behavior: "immediate" },
  );
}

export function completeJob(db: Db, jobId: string, now = new Date()): void {
  db.update(jobs).set({ completedAt: now }).where(eq(jobs.id, jobId)).run();
}

export function failJob(
  db: Db,
  job: JobRow,
  error: unknown,
  now = new Date(),
): void {
  const lastError = error instanceof Error ? error.message : String(error);

  if (job.totalTried >= MAX_JOB_ATTEMPTS) {
    // Dead letter: stop retrying a poison job and leave it for a human.
    db.update(jobs)
      .set({ hasError: true, lastError })
      .where(eq(jobs.id, job.id))
      .run();
    console.error(
      `Job ${job.id} (${job.task}) moved to the dead letter queue: ${lastError}`,
    );
    return;
  }

  db.update(jobs)
    .set({
      visibleAt: new Date(now.getTime() + retryDelayMs(job.totalTried)),
      lastError,
    })
    .where(eq(jobs.id, job.id))
    .run();
}

export async function runDueJobs(
  db: Db,
  handlers: JobHandlers,
  now: () => Date = () => new Date(),
): Promise<number> {
  let processed = 0;

  while (processed < MAX_JOBS_PER_RUN) {
    const job = claimJob(db, now());

    if (!job) {
      break;
    }

    processed += 1;
    const handler = handlers[job.task];

    try {
      if (!handler) {
        throw new Error(`No handler registered for task "${job.task}".`);
      }

      await handler(job);
      // Ack only after the work succeeded.
      completeJob(db, job.id, now());
    } catch (error) {
      failJob(db, job, error, now());
    }
  }

  return processed;
}
