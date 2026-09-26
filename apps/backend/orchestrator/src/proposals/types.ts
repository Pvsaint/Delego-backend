/**
 * Purchase Proposal types — Issue #265
 * Validates agent order recommendations against user spending limits
 * and issues a formal purchase proposal.
 */

export interface CreateProposalRequest {
  userId: string;
  delegationId: string;
  merchantAddress: string;
  items: {
    productId: string;
    title: string;
    quantity: number;
    unitPriceStroops: string;
  }[];
  totalAmountStroops: string;
  assetCode: string;
  rationale: string;
}

export interface PurchaseProposalRecord {
  id: string;
  userId: string;
  delegationId: string;
  merchantAddress: string;
  items: {
    productId: string;
    title: string;
    quantity: number;
    unitPriceStroops: string;
  }[];
  totalAmountStroops: string;
  assetCode: string;
  rationale: string;
  status: "pending_approval" | "auto_approved" | "rejected" | "expired";
  requiresManualApproval: boolean;
  delegationLimitRemainingStroops: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalLimitCheckResult {
  allowed: boolean;
  remainingStroops: string;
  requiresManualApproval: boolean;
  reason?: string;
}

/** Thrown when the delegation limit would be exceeded by this proposal. */
export class DelegationLimitExceededError extends Error {
  constructor(
    public readonly delegationId: string,
    public readonly requestedStroops: string,
    public readonly remainingStroops: string
  ) {
    super(
      `Delegation ${delegationId} has insufficient remaining allowance: ` +
        `requested ${requestedStroops} stroops but only ${remainingStroops} remain`
    );
    this.name = "DelegationLimitExceededError";
  }
}

/** Thrown when concurrent proposals race to consume the same allowance. */
export class ConcurrentProposalConflictError extends Error {
  constructor(public readonly delegationId: string) {
    super(
      `Concurrent proposal conflict for delegation ${delegationId}: ` +
        `another proposal claimed the allowance — retry after a short backoff`
    );
    this.name = "ConcurrentProposalConflictError";
  }
}
