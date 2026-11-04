import { PHASE_PRODUCTION_BUILD } from "next/constants";

export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD
  ) {
    return;
  }

  const { startJobWorker } = await import("./lib/worker");
  startJobWorker();
}
