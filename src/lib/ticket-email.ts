import { and, eq } from "drizzle-orm";
import { Resend } from "resend";
import type { Db } from "@/db/client";
import { events, reservations } from "@/db/schema";
import { formatEventDate, formatPrice } from "./format";
import { enqueueJob, type JobHandler } from "./jobs";
import { getAppUrl } from "./stripe";

const DEFAULT_FROM = "onboarding@resend.dev";

export type TicketEmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type EmailGateway = {
  send(message: TicketEmailMessage): Promise<void>;
};

export type TicketEmailData = {
  code: string;
  eventTitle: string;
  venue: string;
  startsAt: Date;
  seatId: string;
  customerName: string;
  cardAmount: number;
  pointsUsed: number;
  pointsEarned: number;
};

export function ticketEmailJobId(reservationId: string): string {
  return `email:ticket:${reservationId}`;
}

export function ticketEmailIdempotencyKey(reservationId: string): string {
  return `ticket/${reservationId}`;
}

export function enqueueTicketEmail(
  tx: Db,
  reservationId: string,
  now = new Date(),
): void {
  enqueueJob(
    tx,
    {
      id: ticketEmailJobId(reservationId),
      task: "send-ticket-email",
      input: { reservationId },
    },
    now,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildTicketEmail(data: TicketEmailData): {
  subject: string;
  html: string;
  text: string;
} {
  const when = formatEventDate(data.startsAt.toISOString());
  // The link is built from our own APP_URL and generated code only.
  const ticketUrl = `${getAppUrl()}/reservations/${encodeURIComponent(
    data.code,
  )}`;
  const rows: Array<[string, string]> = [
    ["Kod biletu", data.code],
    ["Seans", data.eventTitle],
    ["Sala", data.venue],
    ["Termin", when],
    ["Miejsce", data.seatId],
    ["Zapłacono kartą", formatPrice(data.cardAmount)],
    ["Wykorzystane punkty", String(data.pointsUsed)],
    ["Zdobyte punkty", String(data.pointsEarned)],
  ];

  const html = `<!doctype html>
<html lang="pl">
<body style="font-family: sans-serif; color: #111;">
<h1>Twój bilet</h1>
<p>Dzień dobry ${escapeHtml(data.customerName)}, dziękujemy za zakup.</p>
<table cellpadding="6" style="border-collapse: collapse;">
${rows
  .map(
    ([label, value]) =>
      `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(
        value,
      )}</td></tr>`,
  )
  .join("\n")}
</table>
<p><a href="${escapeHtml(ticketUrl)}">Zobacz bilet</a></p>
</body>
</html>`;

  const text = [
    `Dzień dobry ${data.customerName}, dziękujemy za zakup.`,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    `Bilet: ${ticketUrl}`,
  ].join("\n");

  return {
    subject: `Twój bilet: ${data.eventTitle} (${data.code})`,
    html,
    text,
  };
}

export function createResendGateway(
  resend: Resend,
  from: string,
): EmailGateway {
  return {
    async send(message) {
      const { error } = await resend.emails.send(
        {
          from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        },
        { idempotencyKey: message.idempotencyKey },
      );

      if (error) {
        throw new Error(
          `Resend rejected the ticket email (${error.name}, ${
            error.statusCode ?? "no status"
          }).`,
        );
      }
    },
  };
}

let resendGateway: EmailGateway | null = null;

export function getResendGateway(): EmailGateway | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  resendGateway ??= createResendGateway(
    new Resend(apiKey),
    process.env.RESEND_FROM?.trim() || DEFAULT_FROM,
  );

  return resendGateway;
}

export function createTicketEmailHandler(
  db: Db,
  getGateway: () => EmailGateway | null,
): JobHandler {
  return async (job) => {
    const reservationId = job.input.reservationId;
    const row = db
      .select({ reservation: reservations, event: events })
      .from(reservations)
      .innerJoin(events, eq(events.id, reservations.eventId))
      .where(
        and(
          eq(reservations.id, reservationId),
          eq(reservations.status, "paid"),
        ),
      )
      .get();

    if (!row?.reservation.code) {
      throw new Error(`Reservation ${reservationId} has no paid ticket.`);
    }

    const gateway = getGateway();

    if (!gateway) {
      throw new Error("Resend is not configured.");
    }

    const { reservation, event } = row;
    const message = buildTicketEmail({
      code: row.reservation.code,
      eventTitle: event.title,
      venue: event.venue,
      startsAt: event.startsAt,
      seatId: reservation.seatId,
      customerName: reservation.customerName,
      cardAmount: reservation.amount - reservation.pointsUsed,
      pointsUsed: reservation.pointsUsed,
      pointsEarned: reservation.pointsEarned ?? 0,
    });

    await gateway.send({
      ...message,
      to: reservation.email,
      idempotencyKey: ticketEmailIdempotencyKey(reservationId),
    });
  };
}
