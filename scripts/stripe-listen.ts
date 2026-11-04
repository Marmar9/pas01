import { spawn } from "node:child_process";

// Bun loads .env.local itself, so no `stripe login` is needed.

const WEBHOOK_URL = "localhost:3000/api/webhooks/stripe";
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
];

const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

if (!secretKey?.startsWith("sk_test_")) {
  console.error(
    "STRIPE_SECRET_KEY is missing or not a test key (sk_test_…). Put it in .env.local.",
  );
  process.exit(1);
}

const child = spawn(
  "stripe",
  ["listen", "--forward-to", WEBHOOK_URL, "--events", EVENTS.join(",")],
  {
    env: { ...process.env, STRIPE_API_KEY: secretKey },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code) => process.exit(code ?? 1));
