import {
  ApiClient,
  LoyaltiesApi,
  LoyaltiesMembersBalanceUpdateRequestBody,
  LoyaltiesMembersCreateRequestBody,
} from "@voucherify/sdk";
import {
  LoyaltyError,
  type LoyaltyErrorKind,
  type LoyaltyGateway,
  normalizeEmail,
} from "./loyalty";

const DEFAULT_API_URL = "https://api.voucherify.io";
const REQUEST_TIMEOUT_MS = 8_000;
const RECONCILE_PAGE_SIZE = 50;

export type VoucherifyConfig = {
  appId: string;
  secretKey: string;
  campaignId: string;
  apiUrl: string;
};

export function getVoucherifyConfig(): VoucherifyConfig | null {
  const appId = process.env.VOUCHERIFY_APP_ID?.trim();
  const secretKey = process.env.VOUCHERIFY_SECRET_KEY?.trim();
  const campaignId = process.env.VOUCHERIFY_LOYALTY_CAMPAIGN_ID?.trim();

  if (!appId || !secretKey || !campaignId) {
    return null;
  }

  return {
    appId,
    secretKey,
    campaignId,
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

function classifyMutationError(error: unknown): LoyaltyErrorKind {
  const { status, response } = (error ?? {}) as HttpError;

  if (typeof status !== "number" || status >= 500) {
    return "uncertain";
  }

  const key = String(response?.body?.key ?? "");
  const message = String(response?.body?.message ?? "");

  if (status === 400 && /point|balance/i.test(`${key} ${message}`)) {
    return "insufficient_points";
  }

  // 429 and other 4xx responses are refusals: nothing was applied.
  return "not_applied";
}

// Never include the raw SDK error: its request carries the customer email.
function describeError(error: unknown): string {
  const { status, timeout } = (error ?? {}) as HttpError;

  if (timeout) {
    return "timeout";
  }

  return typeof status === "number" ? `HTTP ${status}` : "network error";
}

const globalForVoucherify = globalThis as typeof globalThis & {
  cinemaVoucherifyMembers?: Map<string, Promise<string>>;
};

export function createVoucherifyGateway(
  config: VoucherifyConfig,
): LoyaltyGateway {
  const client = new ApiClient(config.apiUrl);
  const authentications = client.authentications as unknown as Record<
    string,
    { apiKey?: string }
  >;
  authentications["X-App-Id"].apiKey = config.appId;
  authentications["X-App-Token"].apiKey = config.secretKey;
  client.timeout = REQUEST_TIMEOUT_MS;

  const loyalties = new LoyaltiesApi(client);
  globalForVoucherify.cinemaVoucherifyMembers ??= new Map();
  const members = globalForVoucherify.cinemaVoucherifyMembers;

  async function joinCampaign(
    email: string,
  ): Promise<{ memberId: string; balance: number | null }> {
    // The publication source_id makes joining idempotent: concurrent first
    // requests get the same loyalty card and the welcome balance only once.
    const card = await loyalties.addMember(
      config.campaignId,
      LoyaltiesMembersCreateRequestBody.constructFromObject({
        source_id: `loyalty:member:${email}`,
        customer: { source_id: email, email } as never,
      }),
    );

    if (!card?.code) {
      throw new LoyaltyError("uncertain", "Voucherify returned no card code.");
    }

    return {
      memberId: card.code,
      balance: card.loyalty_card?.balance ?? null,
    };
  }

  // Coalesces concurrent joins for one email and remembers the card code, so
  // later calls skip the join request.
  function join(email: string) {
    const joined = joinCampaign(email);
    const id = joined.then((member) => member.memberId);
    members.set(email, id);
    id.catch(() => members.delete(email));
    return joined;
  }

  async function memberId(rawEmail: string): Promise<string> {
    const email = normalizeEmail(rawEmail);
    return members.get(email) ?? (await join(email)).memberId;
  }

  return {
    async getBalance(rawEmail) {
      const email = normalizeEmail(rawEmail);

      try {
        if (!members.has(email)) {
          const member = await join(email);

          if (member.balance !== null) {
            return member.balance;
          }
        }

        const card = await loyalties.getMember(await memberId(email));
        const balance = card?.loyalty_card?.balance;

        if (typeof balance !== "number") {
          throw new Error("Voucherify returned no loyalty balance.");
        }

        return balance;
      } catch (error) {
        throw new LoyaltyError(
          "not_applied",
          `Voucherify balance read failed (${describeError(error)}).`,
        );
      }
    },

    async adjustBalance({ email, points, sourceId }) {
      let id: string;

      try {
        id = await memberId(email);
      } catch (error) {
        throw new LoyaltyError(
          "not_applied",
          `Voucherify member lookup failed (${describeError(error)}).`,
        );
      }

      try {
        await loyalties.updateLoyaltyCardBalance(
          id,
          LoyaltiesMembersBalanceUpdateRequestBody.constructFromObject({
            points,
            source_id: sourceId,
            reason: sourceId,
          }),
        );
      } catch (error) {
        throw new LoyaltyError(
          classifyMutationError(error),
          `Voucherify balance update failed (${describeError(error)}).`,
        );
      }
    },

    async hasTransaction({ email, sourceId }) {
      try {
        const transactions = await loyalties.listLoyaltyCardTransactions(
          await memberId(email),
          { limit: RECONCILE_PAGE_SIZE },
        );

        return (transactions?.data ?? []).some(
          (transaction) => transaction.source_id === sourceId,
        );
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

  gateway ??= createVoucherifyGateway(config);

  return gateway;
}
