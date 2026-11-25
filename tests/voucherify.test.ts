import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { LoyaltyError } from "@/lib/loyalty";
import { createVoucherifyGateway } from "@/lib/voucherify";

// A local stand-in for the documented Loyalty v2 endpoints, so the gateway is
// exercised through the real SDK (paths, query params and bodies on the wire).
type StubTransaction = {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  details: {
    reason: string | null;
    rejection: { reason: string; details: string } | null;
  };
};

const PROGRAM = "lprg_1";
const stub = {
  members: new Map<string, { id: string; cardId: string; balance: number }>(),
  customers: [] as unknown[],
  enrollments: [] as unknown[],
  adjustments: [] as Array<{ path: string; body: unknown }>,
  membershipQueries: [] as string[],
  transactions: [] as StubTransaction[],
  failAdjustWith: null as number | null,
  failEnrollWith: null as number | null,
};

let server: ReturnType<typeof Bun.serve>;

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function cards(member: { cardId: string; balance: number }) {
  return [
    {
      member_role: "OWNER",
      card: {
        id: member.cardId,
        card_definition_id: "lcdef_1",
        balance: { points: member.balance, pending_points: 0 },
      },
    },
  ];
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const membership = path.match(
        /^\/v2\/loyalties\/programs\/(lprg_\w+)\/memberships\/(.+)$/,
      );

      if (request.method === "GET" && membership) {
        stub.membershipQueries.push(
          url.searchParams.get("identification_type") ?? "",
        );
        const member = stub.members.get(decodeURIComponent(membership[2]));

        return member
          ? json({ member: { id: member.id }, cards: cards(member) })
          : json(
              {
                code: 404,
                key: "not_found",
                message: "Not found",
              },
              404,
            );
      }

      if (request.method === "POST" && path === "/v1/customers") {
        const body = await request.json();
        stub.customers.push(body);
        return json({ id: "cust_1", ...body });
      }

      if (
        request.method === "POST" &&
        path === `/v2/loyalties/programs/${PROGRAM}/members`
      ) {
        const body = (await request.json()) as {
          customer_identification: { customer_source_id: string };
        };
        stub.enrollments.push(body);
        const email = body.customer_identification.customer_source_id;

        if (stub.failEnrollWith) {
          return json(
            {
              code: stub.failEnrollWith,
              key: "non_active_program",
            },
            stub.failEnrollWith,
          );
        }

        if (stub.members.has(email)) {
          return json({ code: 409, key: "member_already_exists" }, 409);
        }

        const member = {
          id: `lmbr_${stub.members.size + 1}`,
          cardId: `lcrd_${stub.members.size + 1}`,
          balance: 0,
        };
        stub.members.set(email, member);

        return json({ id: member.id, cards: cards(member) });
      }

      if (request.method === "POST" && path.endsWith("/points")) {
        if (stub.failAdjustWith) {
          return json(
            { code: stub.failAdjustWith, key: "error" },
            stub.failAdjustWith,
          );
        }

        const body = (await request.json()) as { reason: string };
        stub.adjustments.push({ path, body });
        const transaction: StubTransaction = {
          id: `lctx_${stub.transactions.length + 1}`,
          status: "PENDING",
          details: { reason: body.reason, rejection: null },
        };
        stub.transactions.unshift(transaction);

        return json({ transaction, status: "TRANSACTION_CREATED" });
      }

      if (request.method === "GET" && path.endsWith("/transactions")) {
        return json({
          data: stub.transactions.slice(
            0,
            Number(url.searchParams.get("limit")),
          ),
          object: "list",
        });
      }

      return json({ code: 404, key: "not_found" }, 404);
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  stub.members.clear();
  stub.customers = [];
  stub.enrollments = [];
  stub.adjustments = [];
  stub.membershipQueries = [];
  stub.transactions = [];
  stub.failAdjustWith = null;
  stub.failEnrollWith = null;
  Reflect.deleteProperty(globalThis, "cinemaVoucherifyMembers");
});

function gateway(enrolled: string[] = []) {
  return createVoucherifyGateway(
    {
      appId: "app",
      secretKey: "secret",
      programId: PROGRAM,
      cardDefinitionId: null,
      apiUrl: `http://localhost:${server.port}`,
    },
    { beforeEnroll: (email) => enrolled.push(email) },
  );
}

describe("Voucherify Loyalty v2 gateway", () => {
  test("enrolls a new customer by email and records the welcome hook first", async () => {
    const enrolled: string[] = [];
    const balance = await gateway(enrolled).getBalance(" Jan@Example.com ");

    expect(balance).toBe(0);
    expect(enrolled).toEqual(["jan@example.com"]);
    expect(stub.membershipQueries).toEqual(["customer_source_id"]);
    expect(stub.customers).toEqual([
      { source_id: "jan@example.com", email: "jan@example.com" },
    ]);
    expect(stub.enrollments).toEqual([
      {
        customer_identification: {
          type: "customer_source_id",
          customer_source_id: "jan@example.com",
        },
      },
    ]);
  });

  test("reads an existing member without enrolling it again", async () => {
    stub.members.set("ola@example.com", {
      id: "lmbr_9",
      cardId: "lcrd_9",
      balance: 750,
    });
    const enrolled: string[] = [];

    expect(await gateway(enrolled).getBalance("ola@example.com")).toBe(750);
    expect(enrolled).toEqual([]);
    expect(stub.enrollments).toEqual([]);
  });

  test("adjusts points on the member's card and follows the transaction", async () => {
    stub.members.set("ola@example.com", {
      id: "lmbr_9",
      cardId: "lcrd_9",
      balance: 750,
    });
    const loyalty = gateway();

    const created = await loyalty.adjustBalance({
      email: "ola@example.com",
      points: -500,
      sourceId: "loyalty:spend:cs_1",
    });

    expect(created).toEqual({
      id: "lctx_1",
      status: "pending",
      insufficientPoints: false,
    });
    expect(stub.adjustments).toEqual([
      {
        path: `/v2/loyalties/programs/${PROGRAM}/members/lmbr_9/cards/lcrd_9/points`,
        body: { points: -500, reason: "loyalty:spend:cs_1" },
      },
    ]);

    // A lost response is found again by the reason we sent.
    expect(
      await loyalty.findTransaction({
        email: "ola@example.com",
        sourceId: "loyalty:spend:cs_1",
        transactionId: null,
      }),
    ).toMatchObject({ id: "lctx_1", status: "pending" });

    stub.transactions[0].status = "REJECTED";
    stub.transactions[0].details.rejection = {
      // The reason Voucherify returned in the live Sandbox test.
      reason: "NOT_ENOUGH_BALANCE",
    } as { reason: string; details: string };

    expect(
      await loyalty.findTransaction({
        email: "ola@example.com",
        sourceId: "loyalty:spend:cs_1",
        transactionId: "lctx_1",
      }),
    ).toEqual({
      id: "lctx_1",
      status: "rejected",
      insufficientPoints: true,
    });
    // A rejected transaction never counts as our earlier attempt.
    expect(
      await loyalty.findTransaction({
        email: "ola@example.com",
        sourceId: "loyalty:spend:cs_1",
        transactionId: null,
      }),
    ).toBeNull();
  });

  test("reports an enrollment refused by an inactive program as permanent", async () => {
    stub.failEnrollWith = 423;
    const error = await gateway()
      .adjustBalance({
        email: "new@example.com",
        points: 1000,
        sourceId: "loyalty:welcome:x",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LoyaltyError);
    expect((error as LoyaltyError).kind).toBe("rejected");
    expect(stub.adjustments).toEqual([]);
  });

  test("classifies refusals so jobs retry only what can succeed", async () => {
    stub.members.set("ola@example.com", {
      id: "lmbr_9",
      cardId: "lcrd_9",
      balance: 750,
    });
    const loyalty = gateway();
    const kindFor = async (status: number) => {
      stub.failAdjustWith = status;
      const error = await loyalty
        .adjustBalance({
          email: "ola@example.com",
          points: 10,
          sourceId: "loyalty:earn:r1",
        })
        .catch((caught: unknown) => caught);

      return error instanceof LoyaltyError ? error.kind : "not a LoyaltyError";
    };

    expect(await kindFor(429)).toBe("not_applied");
    expect(await kindFor(423)).toBe("rejected");
    expect(await kindFor(500)).toBe("uncertain");
  });
});
