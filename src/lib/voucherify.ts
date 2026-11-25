import { ApiClient, CustomersApi, LV2ProgramsApi } from "@voucherify/sdk";
import { getDb } from "@/db/client";
import {
  LoyaltyError,
  type LoyaltyErrorKind,
  type LoyaltyGateway,
  type LoyaltyTransaction,
  normalizeEmail,
  recordWelcomePoints,
} from "./loyalty";

const DEFAULT_API_URL = "https://api.voucherify.io";
const REQUEST_TIMEOUT_MS = 8_000;
// Newest card transactions scanned to find one of ours (the API maximum).
const TRANSACTION_PAGE_SIZE = 100;

export type VoucherifyConfig = {
  appId: string;
  secretKey: string;
  // Loyalty v2 program (lprg_...).
  programId: string;
  // Point wallet (lcdef_...) to use when the program has several; otherwise
  // the member's first card.
  cardDefinitionId: string | null;
  apiUrl: string;
};

export function getVoucherifyConfig(): VoucherifyConfig | null {
  const appId = process.env.VOUCHERIFY_APP_ID?.trim();
  const secretKey = process.env.VOUCHERIFY_SECRET_KEY?.trim();
  const programId = process.env.VOUCHERIFY_LOYALTY_PROGRAM_ID?.trim();

  if (!appId || !secretKey || !programId) {
    return null;
  }

  return {
    appId,
    secretKey,
    programId,
    cardDefinitionId:
      process.env.VOUCHERIFY_LOYALTY_CARD_DEFINITION_ID?.trim() || null,
    apiUrl: (process.env.VOUCHERIFY_API_URL?.trim() || DEFAULT_API_URL).replace(
      /\/$/,
      "",
    ),
  };
}

type HttpError = {
  status?: unknown;
  timeout?: unknown;
  response?: { body?: { key?: unknown; message?: unknown } };
};

function httpStatus(error: unknown): number | null {
  const { status } = (error ?? {}) as HttpError;
  return typeof status === "number" ? status : null;
}

function classifyMutationError(error: unknown): LoyaltyErrorKind {
  const status = httpStatus(error);

  if (status === null || status >= 500) {
    return "uncertain";
  }

  const { response } = (error ?? {}) as HttpError;
  const key = String(response?.body?.key ?? "");
  const message = String(response?.body?.message ?? "");

  if (status === 400 && /point|balance/i.test(`${key} ${message}`)) {
    return "insufficient_points";
  }

  // 4xx responses are refusals: nothing was applied. A 429 may succeed later
  // and a 404 may mean our cached member/card ids are stale; any other 4xx
  // (e.g. 423 program not active) fails the same way on every retry.
  return status === 429 || status === 404 ? "not_applied" : "rejected";
}

// Nothing was changed when the member could not be found or enrolled. A
// refusal such as 423 (program not ACTIVE) repeats on every retry, so the job
// is dead-lettered instead of spending the call budget; 429, 5xx and network
// errors may pass later.
function memberLookupErrorKind(error: unknown): LoyaltyErrorKind {
  const status = httpStatus(error);

  return status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 404 &&
    status !== 409 &&
    status !== 429
    ? "rejected"
    : "not_applied";
}

// Never include the raw SDK error: its request carries the customer email.
function describeError(error: unknown): string {
  const { timeout } = (error ?? {}) as HttpError;

  if (timeout) {
    return "timeout";
  }

  const status = httpStatus(error);

  return status === null ? "network error" : `HTTP ${status}`;
}

type MemberCard = { memberId: string; cardId: string; balance: number };

type CardEntry = {
  card?: {
    id?: string;
    card_definition_id?: string;
    balance?: { points?: number };
  };
};

type RawTransaction = {
  id?: string;
  status?: string;
  details?: {
    reason?: string | null;
    rejection?: { reason?: string; details?: string } | null;
  } | null;
};

function toTransaction(raw: RawTransaction | null | undefined) {
  if (!raw?.id) {
    return null;
  }

  const rejection = raw.details?.rejection;
  const status: LoyaltyTransaction["status"] =
    raw.status === "APPROVED"
      ? "approved"
      : raw.status === "REJECTED"
        ? "rejected"
        : "pending";

  return {
    id: raw.id,
    status,
    insufficientPoints:
      status === "rejected" &&
      /insufficient|balance|not enough|negative/i.test(
        `${rejection?.reason ?? ""} ${rejection?.details ?? ""}`,
      ),
  } satisfies LoyaltyTransaction;
}

const globalForVoucherify = globalThis as typeof globalThis & {
  cinemaVoucherifyMembers?: Map<string, Promise<MemberCard>>;
};

export function createVoucherifyGateway(
  config: VoucherifyConfig,
  hooks: { beforeEnroll?: (email: string) => void } = {},
): LoyaltyGateway {
  const client = new ApiClient(config.apiUrl);
  const authentications = client.authentications as unknown as Record<
    string,
    { apiKey?: string }
  >;
  authentications["X-App-Id"].apiKey = config.appId;
  authentications["X-App-Token"].apiKey = config.secretKey;
  client.timeout = REQUEST_TIMEOUT_MS;

  const programs = new LV2ProgramsApi(client);
  const customers = new CustomersApi(client);
  globalForVoucherify.cinemaVoucherifyMembers ??= new Map();
  const members = globalForVoucherify.cinemaVoucherifyMembers;

  function pickCard(memberId: string | undefined, cards: CardEntry[] = []) {
    const entry = config.cardDefinitionId
      ? cards.find(
          (candidate) =>
            candidate.card?.card_definition_id === config.cardDefinitionId,
        )
      : cards[0];

    if (!memberId || !entry?.card?.id) {
      throw new Error("Voucherify returned no loyalty card for the member.");
    }

    return {
      memberId,
      cardId: entry.card.id,
      balance: entry.card.balance?.points ?? 0,
    };
  }

  async function lookUp(email: string): Promise<MemberCard | null> {
    try {
      const membership = await programs.getProgramMembership(
        config.programId,
        email,
        { identificationType: "customer_source_id" },
      );

      return pickCard(
        membership?.member?.id,
        membership?.cards as CardEntry[] | undefined,
      );
    } catch (error) {
      // 404: the customer does not exist or is not a member yet.
      if (httpStatus(error) === 404) {
        return null;
      }

      throw error;
    }
  }

  async function enroll(email: string): Promise<MemberCard> {
    // Recorded before the member exists, so the welcome credit survives a
    // lost enrollment response.
    hooks.beforeEnroll?.(email);
    // Upsert: the customer source_id is the normalized email.
    await customers.createCustomer({ source_id: email, email } as never);

    try {
      const member = await programs.createProgramMember(config.programId, {
        customer_identification: {
          type: "customer_source_id",
          customer_source_id: email,
        },
      } as never);

      return pickCard(member?.id, member?.cards as CardEntry[] | undefined);
    } catch (error) {
      // A concurrent request enrolled the customer first.
      if (httpStatus(error) === 409) {
        const existing = await lookUp(email);

        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  // Coalesces concurrent lookups/enrollments for one email; the ids are
  // remembered so later mutations skip the lookup. The balance is re-read by
  // getBalance.
  function loadMember(email: string): Promise<MemberCard> {
    const loaded = (async () =>
      (await lookUp(email)) ?? (await enroll(email)))();
    members.set(email, loaded);
    loaded.catch(() => members.delete(email));
    return loaded;
  }

  function memberCard(rawEmail: string): Promise<MemberCard> {
    const email = normalizeEmail(rawEmail);
    return members.get(email) ?? loadMember(email);
  }

  return {
    async getBalance(rawEmail) {
      try {
        return (await loadMember(normalizeEmail(rawEmail))).balance;
      } catch (error) {
        throw new LoyaltyError(
          "not_applied",
          `Voucherify balance read failed (${describeError(error)}).`,
        );
      }
    },

    async adjustBalance({ email, points, sourceId }) {
      let card: MemberCard;

      try {
        card = await memberCard(email);
      } catch (error) {
        throw new LoyaltyError(
          memberLookupErrorKind(error),
          `Voucherify member lookup failed (${describeError(error)}).`,
        );
      }

      let transaction: LoyaltyTransaction | null;

      try {
        const result = await programs.adjustCardPoints(
          config.programId,
          card.memberId,
          card.cardId,
          { points, reason: sourceId } as never,
        );
        transaction = toTransaction(result?.transaction as RawTransaction);
      } catch (error) {
        const kind = classifyMutationError(error);

        if (httpStatus(error) === 404) {
          members.delete(normalizeEmail(email));
        }

        throw new LoyaltyError(
          kind,
          `Voucherify balance update failed (${describeError(error)}).`,
        );
      }

      if (!transaction) {
        throw new LoyaltyError(
          "uncertain",
          "Voucherify returned no card transaction.",
        );
      }

      return transaction;
    },

    async findTransaction({ email, sourceId, transactionId }) {
      try {
        const card = await memberCard(email);
        const page = await programs.listCardTransactions(
          config.programId,
          card.memberId,
          card.cardId,
          { limit: TRANSACTION_PAGE_SIZE },
        );
        const transactions = (page?.data ?? []) as RawTransaction[];
        const match = transactionId
          ? transactions.find((candidate) => candidate.id === transactionId)
          : transactions.find(
              (candidate) =>
                candidate.details?.reason === sourceId &&
                candidate.status !== "REJECTED",
            );

        return toTransaction(match);
      } catch (error) {
        throw new LoyaltyError(
          "uncertain",
          `Voucherify transaction lookup failed (${describeError(error)}).`,
        );
      }
    },
  };
}

let gateway: LoyaltyGateway | null = null;

export function getVoucherifyGateway(): LoyaltyGateway | null {
  const config = getVoucherifyConfig();

  if (!config) {
    return null;
  }

  gateway ??= createVoucherifyGateway(config, {
    beforeEnroll: (email) => recordWelcomePoints(getDb(), email),
  });

  return gateway;
}
