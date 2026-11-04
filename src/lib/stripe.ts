import Stripe from "stripe";

export const STRIPE_CURRENCY = "pln";

export type CheckoutSessionInput = {
  reservationId: string;
  amount: number;
  customerEmail: string;
  eventTitle: string;
  seatId: string;
  idempotencyKey: string;
};

export type CheckoutSession = {
  id: string;
  url: string | null;
};

export type CheckoutGateway = {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
  expireCheckoutSession(sessionId: string): Promise<void>;
};

let stripeClient: Stripe | null = null;

export function getStripeSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();

  if (!key) {
    return null;
  }

  // This project deliberately supports test mode only.
  if (!key.startsWith("sk_test_")) {
    console.error(
      "Stripe is configured with a non-test secret key; refusing it.",
    );
    return null;
  }

  return key;
}

export function getStripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

export function getAppUrl(): string {
  return (process.env.APP_URL?.trim() || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

export function getStripeClient(): Stripe | null {
  const key = getStripeSecretKey();

  if (!key) {
    return null;
  }

  stripeClient ??= new Stripe(key);

  return stripeClient;
}

export function createStripeCheckoutGateway(stripe: Stripe): CheckoutGateway {
  return {
    async createCheckoutSession(input) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          client_reference_id: input.reservationId,
          customer_email: input.customerEmail,
          metadata: { reservationId: input.reservationId },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: STRIPE_CURRENCY,
                unit_amount: input.amount,
                product_data: {
                  name: `Bilet: ${input.eventTitle}`,
                  description: `Miejsce ${input.seatId}`,
                },
              },
            },
          ],
          success_url: `${getAppUrl()}/reservations/${encodeURIComponent(
            input.reservationId,
          )}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${getAppUrl()}/reservations/${encodeURIComponent(
            input.reservationId,
          )}/payment/cancel`,
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return { id: session.id, url: session.url };
    },

    async expireCheckoutSession(sessionId) {
      await stripe.checkout.sessions.expire(sessionId);
    },
  };
}

export function getStripeCheckoutGateway(): CheckoutGateway | null {
  const stripe = getStripeClient();

  return stripe ? createStripeCheckoutGateway(stripe) : null;
}

