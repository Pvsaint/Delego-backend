/**
 * Proposal Service tests — Issue #265
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProposalService } from "./service.js";
import {
  DelegationLimitExceededError,
  ConcurrentProposalConflictError,
} from "./types.js";
import type { CreateProposalRequest } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDelegationRow(overrides: Partial<{
  spent_stroops: string;
  max_total: string;
  auto_approve_threshold_stroops: string | null;
  version: number;
}> = {}) {
  return {
    id: "d1",
    spent_stroops: overrides.spent_stroops ?? "0",
    max_total: overrides.max_total ?? "100000000000",
    auto_approve_threshold_stroops: overrides.auto_approve_threshold_stroops ?? null,
    version: overrides.version ?? 1,
  };
}

function makeRequest(overrides: Partial<CreateProposalRequest> = {}): CreateProposalRequest {
  return {
    userId: "u1",
    delegationId: "d1",
    merchantAddress: "GCMERCHANT",
    items: [{ productId: "p1", title: "Widget", quantity: 1, unitPriceStroops: "5000000000" }],
    totalAmountStroops: "5000000000",
    assetCode: "XLM",
    rationale: "Buying a widget",
    ...overrides,
  };
}

function makePoolClient(delegationRow: ReturnType<typeof makeDelegationRow>, updateRowCount = 1) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (/FOR UPDATE/i.test(sql)) return Promise.resolve({ rowCount: 1, rows: [delegationRow] });
      if (/UPDATE delegations/i.test(sql)) return Promise.resolve({ rowCount: updateRowCount });
      if (/INSERT INTO purchase_proposals/i.test(sql)) return Promise.resolve({ rowCount: 1 });
      if (/INSERT INTO service_event_outbox/i.test(sql)) return Promise.resolve({ rowCount: 1 });
      return Promise.resolve({ rowCount: 0, rows: [] });
    }),
    release: vi.fn(),
  };
}

function makePool(delegationRow: ReturnType<typeof makeDelegationRow>, updateRowCount = 1) {
  const client = makePoolClient(delegationRow, updateRowCount);
  return {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(),
    _client: client,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ProposalService.createProposal", () => {
  it("returns auto_approved for amounts within threshold", async () => {
    const pool = makePool(makeDelegationRow({ max_total: "100000000000", spent_stroops: "0" }));
    const service = new ProposalService(pool as any);
    const result = await service.createProposal(makeRequest({ totalAmountStroops: "5000000000" }));

    expect(result.status).toBe("auto_approved");
    expect(result.requiresManualApproval).toBe(false);
  });

  it("returns pending_approval for amounts above auto-approve threshold", async () => {
    const pool = makePool(
      makeDelegationRow({
        max_total: "1000000000000",
        spent_stroops: "0",
        auto_approve_threshold_stroops: "1000000",
      })
    );
    const service = new ProposalService(pool as any);
    const result = await service.createProposal(
      makeRequest({ totalAmountStroops: "5000000000" })
    );

    expect(result.status).toBe("pending_approval");
    expect(result.requiresManualApproval).toBe(true);
  });

  it("emits an outbox event when manual approval is required", async () => {
    const pool = makePool(
      makeDelegationRow({
        max_total: "1000000000000",
        spent_stroops: "0",
        auto_approve_threshold_stroops: "1000000",
      })
    );
    const service = new ProposalService(pool as any);
    await service.createProposal(makeRequest({ totalAmountStroops: "5000000000" }));

    const client = pool._client;
    const outboxCall = (client.query as any).mock.calls.find(
      (c: string[]) => typeof c[0] === "string" && c[0].includes("service_event_outbox")
    );
    expect(outboxCall).toBeDefined();
  });

  it("throws DelegationLimitExceededError when amount exceeds remaining", async () => {
    const pool = makePool(
      makeDelegationRow({ max_total: "10000000000", spent_stroops: "9500000000" })
    );
    const service = new ProposalService(pool as any);

    await expect(
      service.createProposal(makeRequest({ totalAmountStroops: "5000000000" }))
    ).rejects.toThrow(DelegationLimitExceededError);
  });

  it("throws ConcurrentProposalConflictError when version races", async () => {
    const pool = makePool(
      makeDelegationRow({ max_total: "100000000000", spent_stroops: "0" }),
      0 // updateRowCount = 0 simulates a lost race
    );
    const service = new ProposalService(pool as any);

    await expect(
      service.createProposal(makeRequest())
    ).rejects.toThrow(ConcurrentProposalConflictError);
  });

  it("calculates delegationLimitRemainingStroops correctly", async () => {
    const pool = makePool(
      makeDelegationRow({ max_total: "100000000000", spent_stroops: "20000000000" })
    );
    const service = new ProposalService(pool as any);
    const result = await service.createProposal(
      makeRequest({ totalAmountStroops: "5000000000" })
    );

    // remaining = 100000000000 - 20000000000 - 5000000000 = 75000000000
    expect(result.delegationLimitRemainingStroops).toBe("75000000000");
  });
});

describe("ProposalService.checkLimit", () => {
  it("returns allowed=true when within limits", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            spent_stroops: "0",
            max_total: "100000000000",
            auto_approve_threshold_stroops: null,
          },
        ],
      }),
    };
    const service = new ProposalService(pool as any);
    const result = await service.checkLimit("u1", "d1", "5000000000");

    expect(result.allowed).toBe(true);
    expect(result.remainingStroops).toBe("100000000000");
  });

  it("returns allowed=false when delegation is inactive/not found", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
    };
    const service = new ProposalService(pool as any);
    const result = await service.checkLimit("u1", "d1", "5000000000");

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });
});
