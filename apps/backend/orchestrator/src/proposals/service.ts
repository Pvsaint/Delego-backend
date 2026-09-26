/**
 * Purchase Proposal Service — Issue #265
 *
 * Receives agent order recommendations, validates against the user's
 * delegation spending limits, and issues a formal purchase proposal.
 *
 * Atomicity guarantee: the allowance check and deduction run inside a
 * single PostgreSQL transaction using SELECT … FOR UPDATE, which
 * serialises concurrent proposals for the same delegation and prevents
 * double-spending.
 */
import type { Pool, PoolClient } from "pg";
import { createLogger, generateId } from "@delegolabs/utils";
import {
  type CreateProposalRequest,
  type ProposalLimitCheckResult,
  type PurchaseProposalRecord,
  ConcurrentProposalConflictError,
  DelegationLimitExceededError,
} from "./types.js";

const log = createLogger(
  "orchestrator:proposals",
  process.env.LOG_LEVEL ?? "info"
);

/** How long (ms) a proposal stays valid before it expires. Default: 15 minutes. */
const PROPOSAL_TTL_MS = Number(
  process.env.PROPOSAL_TTL_MS ?? 15 * 60 * 1_000
);

/** Stroops threshold below which purchases auto-approve (overridable per delegation). */
const DEFAULT_AUTO_APPROVE_THRESHOLD_STROOPS = BigInt(
  process.env.DEFAULT_AUTO_APPROVE_THRESHOLD_STROOPS ?? "10000000000" // 1 000 XLM in stroops
);

export class ProposalService {
  constructor(private readonly db: Pool) {}

  /**
   * Create a purchase proposal.
   *
   * Steps:
   * 1. Lock the delegation row for update (prevents concurrent over-spend).
   * 2. Verify the requested amount fits within the remaining allowance.
   * 3. Deduct the amount atomically.
   * 4. Persist the proposal record and emit a notification event when
   *    manual approval is required.
   *
   * Throws:
   *  - `DelegationLimitExceededError` when the delegation has no room.
   *  - `ConcurrentProposalConflictError` when a concurrent transaction
   *    won the race and the allowance no longer covers this request.
   */
  async createProposal(
    req: CreateProposalRequest
  ): Promise<PurchaseProposalRecord> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      // ── 1. Lock delegation row ──────────────────────────────────────
      const delegationRow = await this.fetchDelegationForUpdate(
        client,
        req.delegationId,
        req.userId
      );

      const spentStroops = BigInt(delegationRow.spent_stroops ?? "0");
      const maxTotal = BigInt(delegationRow.max_total);
      const autoApproveThreshold = delegationRow.auto_approve_threshold_stroops
        ? BigInt(delegationRow.auto_approve_threshold_stroops)
        : DEFAULT_AUTO_APPROVE_THRESHOLD_STROOPS;

      const requestedAmount = BigInt(req.totalAmountStroops);
      const remainingBefore = maxTotal - spentStroops;

      // ── 2. Limit check ──────────────────────────────────────────────
      if (requestedAmount > remainingBefore) {
        await client.query("ROLLBACK");
        throw new DelegationLimitExceededError(
          req.delegationId,
          req.totalAmountStroops,
          remainingBefore.toString()
        );
      }

      // ── 3. Deduct atomically ────────────────────────────────────────
      const newSpent = spentStroops + requestedAmount;
      const updateResult = await client.query<{ version: number }>(
        `UPDATE delegations
            SET spent_stroops = $1,
                version       = version + 1,
                updated_at    = NOW()
          WHERE id      = $2
            AND version = $3
          RETURNING version`,
        [newSpent.toString(), req.delegationId, delegationRow.version]
      );

      if (updateResult.rowCount === 0) {
        // Another concurrent transaction updated the row between our SELECT … FOR UPDATE
        // and this UPDATE — the FOR UPDATE lock prevents this in practice, but guard anyway.
        await client.query("ROLLBACK");
        throw new ConcurrentProposalConflictError(req.delegationId);
      }

      const remainingAfter = maxTotal - newSpent;
      const requiresManualApproval =
        requestedAmount > autoApproveThreshold;
      const status: PurchaseProposalRecord["status"] = requiresManualApproval
        ? "pending_approval"
        : "auto_approved";

      const proposalId = generateId();
      const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS).toISOString();
      const now = new Date().toISOString();

      // ── 4a. Persist proposal ────────────────────────────────────────
      await client.query(
        `INSERT INTO purchase_proposals
           (id, user_id, delegation_id, merchant_address, items,
            total_amount_stroops, asset_code, rationale, status,
            requires_manual_approval, delegation_limit_remaining_stroops,
            expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          proposalId,
          req.userId,
          req.delegationId,
          req.merchantAddress,
          JSON.stringify(req.items),
          req.totalAmountStroops,
          req.assetCode,
          req.rationale,
          status,
          requiresManualApproval,
          remainingAfter.toString(),
          expiresAt,
          now,
          now,
        ]
      );

      // ── 4b. Emit notification event when manual approval is needed ──
      if (requiresManualApproval) {
        await this.emitApprovalNotificationEvent(client, {
          proposalId,
          userId: req.userId,
          delegationId: req.delegationId,
          totalAmountStroops: req.totalAmountStroops,
          assetCode: req.assetCode,
        });
      }

      await client.query("COMMIT");

      log.info("Purchase proposal created", {
        proposalId,
        status,
        requiresManualApproval,
        userId: req.userId,
        delegationId: req.delegationId,
      });

      return {
        id: proposalId,
        userId: req.userId,
        delegationId: req.delegationId,
        merchantAddress: req.merchantAddress,
        items: req.items,
        totalAmountStroops: req.totalAmountStroops,
        assetCode: req.assetCode,
        rationale: req.rationale,
        status,
        requiresManualApproval,
        delegationLimitRemainingStroops: remainingAfter.toString(),
        expiresAt,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      // Roll back on any unhandled error (DelegationLimitExceededError already rolled back above)
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Check remaining allowance without modifying state — useful for agent
   * pre-flight checks before committing to a proposal.
   */
  async checkLimit(
    userId: string,
    delegationId: string,
    amountStroops: string
  ): Promise<ProposalLimitCheckResult> {
    const result = await this.db.query<{
      spent_stroops: string;
      max_total: string;
      auto_approve_threshold_stroops: string | null;
    }>(
      `SELECT spent_stroops, max_total, auto_approve_threshold_stroops
         FROM delegations
        WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [delegationId, userId]
    );

    if (result.rowCount === 0) {
      return {
        allowed: false,
        remainingStroops: "0",
        requiresManualApproval: false,
        reason: "Delegation not found or inactive",
      };
    }

    const row = result.rows[0];
    const spent = BigInt(row.spent_stroops ?? "0");
    const maxTotal = BigInt(row.max_total);
    const autoApproveThreshold = row.auto_approve_threshold_stroops
      ? BigInt(row.auto_approve_threshold_stroops)
      : DEFAULT_AUTO_APPROVE_THRESHOLD_STROOPS;

    const requested = BigInt(amountStroops);
    const remaining = maxTotal - spent;

    if (requested > remaining) {
      return {
        allowed: false,
        remainingStroops: remaining.toString(),
        requiresManualApproval: false,
        reason: "Insufficient delegation allowance",
      };
    }

    return {
      allowed: true,
      remainingStroops: remaining.toString(),
      requiresManualApproval: requested > autoApproveThreshold,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async fetchDelegationForUpdate(
    client: PoolClient,
    delegationId: string,
    userId: string
  ): Promise<{
    id: string;
    spent_stroops: string;
    max_total: string;
    auto_approve_threshold_stroops: string | null;
    version: number;
  }> {
    const result = await client.query<{
      id: string;
      spent_stroops: string;
      max_total: string;
      auto_approve_threshold_stroops: string | null;
      version: number;
    }>(
      `SELECT id, spent_stroops, max_total, auto_approve_threshold_stroops, version
         FROM delegations
        WHERE id = $1 AND user_id = $2 AND status = 'active'
        FOR UPDATE`,
      [delegationId, userId]
    );

    if (result.rowCount === 0) {
      throw new Error(
        `Active delegation ${delegationId} not found for user ${userId}`
      );
    }

    return result.rows[0];
  }

  private async emitApprovalNotificationEvent(
    client: PoolClient,
    payload: {
      proposalId: string;
      userId: string;
      delegationId: string;
      totalAmountStroops: string;
      assetCode: string;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO service_event_outbox
         (id, aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ($1, 'purchase_proposal', $2, 'proposal.pending_approval', $3::jsonb, NOW())`,
      [generateId(), payload.proposalId, JSON.stringify(payload)]
    );

    log.info("Approval notification event queued", {
      proposalId: payload.proposalId,
      userId: payload.userId,
    });
  }
}
