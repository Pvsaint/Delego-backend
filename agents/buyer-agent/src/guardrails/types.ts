/**
 * Guardrail types — Issue #267
 * Sanitize untrusted merchant text and tool outputs against prompt injection.
 */
import { z } from "zod";

export type FlaggedCategory =
  | "instruction_override"
  | "exfiltration"
  | "budget_tampering";

export interface GuardrailCheckResult {
  isSafe: boolean;
  flaggedCategories: FlaggedCategory[];
  sanitizedText: string;
  /** 0.0 (clean) – 1.0 (highly suspicious) */
  riskScore: number;
}

// ── Zod schemas for tool parameter validation ────────────────────────────────

export const SearchProductsParamsSchema = z.object({
  query: z.string().min(1).max(512),
  category: z.string().max(64).optional(),
  maxPriceStroops: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

export const AddToCartParamsSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(999),
});

export const InitiateCheckoutParamsSchema = z.object({
  delegationId: z.string().uuid(),
  merchantAddress: z.string().min(1).max(64),
  totalAmountStroops: z.string().regex(/^\d+$/),
  assetCode: z.string().min(1).max(12),
  rationale: z.string().min(1).max(2048),
});

export type ToolName =
  | "search_products"
  | "add_to_cart"
  | "initiate_checkout";

export const TOOL_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  search_products: SearchProductsParamsSchema,
  add_to_cart: AddToCartParamsSchema,
  initiate_checkout: InitiateCheckoutParamsSchema,
};
