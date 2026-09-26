/**
 * Proposal routes — Issue #265
 * POST /proposals        — create a proposal
 * GET  /proposals/:id    — fetch a proposal
 * POST /proposals/check  — pre-flight limit check (no state change)
 */
import { createLogger, json, route, requireAuth } from "@delegolabs/utils";
import type { Pool } from "pg";
import { z } from "zod";
import { ProposalService } from "./service.js";
import {
  DelegationLimitExceededError,
  ConcurrentProposalConflictError,
} from "./types.js";

const log = createLogger(
  "orchestrator:proposals:routes",
  process.env.LOG_LEVEL ?? "info"
);

const ProposalItemSchema = z.object({
  productId: z.string().min(1),
  title: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceStroops: z.string().regex(/^\d+$/),
});

const CreateProposalSchema = z.object({
  userId: z.string().uuid(),
  delegationId: z.string().uuid(),
  merchantAddress: z.string().min(1),
  items: z.array(ProposalItemSchema).min(1),
  totalAmountStroops: z.string().regex(/^\d+$/),
  assetCode: z.string().min(1).max(12),
  rationale: z.string().min(1),
});

const CheckLimitSchema = z.object({
  userId: z.string().uuid(),
  delegationId: z.string().uuid(),
  amountStroops: z.string().regex(/^\d+$/),
});

export function createProposalRoutes(db: Pool) {
  const service = new ProposalService(db);

  return [
    route("POST", "/proposals", requireAuth, async (req: Request) => {
      let body: unknown;
      try {
        body = await (req as any).json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const parsed = CreateProposalSchema.safeParse(body);
      if (!parsed.success) {
        return json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
      }

      try {
        const proposal = await service.createProposal(parsed.data);
        return json(proposal, 201);
      } catch (err) {
        if (err instanceof DelegationLimitExceededError) {
          return json({ error: err.message, code: "DELEGATION_LIMIT_EXCEEDED" }, 422);
        }
        if (err instanceof ConcurrentProposalConflictError) {
          return json({ error: err.message, code: "CONCURRENT_CONFLICT" }, 409);
        }
        log.error("Unexpected error creating proposal", {
          error: err instanceof Error ? err.message : String(err),
        });
        return json({ error: "Internal server error" }, 500);
      }
    }),

    route("POST", "/proposals/check", requireAuth, async (req: Request) => {
      let body: unknown;
      try {
        body = await (req as any).json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const parsed = CheckLimitSchema.safeParse(body);
      if (!parsed.success) {
        return json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
      }

      const result = await service.checkLimit(
        parsed.data.userId,
        parsed.data.delegationId,
        parsed.data.amountStroops
      );
      return json(result, 200);
    }),
  ];
}
