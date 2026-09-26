/**
 * Guardrail Middleware — Issue #267
 *
 * Two responsibilities:
 *  1. sanitizeText()  — strips prompt-injection attempts from untrusted
 *                       merchant/product descriptions before they reach the LLM.
 *  2. validateToolParams() — validates all tool call parameters against Zod
 *                            schemas before execution; rejects any call that
 *                            doesn't conform.
 *
 * Security incidents are written to the `security_alerts` table so the ops
 * team can audit them after the fact.
 */
import { createLogger } from "@delegolabs/utils";
import type { Pool } from "pg";
import {
  TOOL_SCHEMAS,
  type FlaggedCategory,
  type GuardrailCheckResult,
  type ToolName,
} from "./types.js";

const log = createLogger(
  "buyer-agent:guardrails",
  process.env.LOG_LEVEL ?? "info"
);

// ── Injection pattern catalogue ───────────────────────────────────────────────
// Each tuple is [category, regex].  Patterns are intentionally case-insensitive
// and use word-boundary anchors where appropriate to reduce false-positives.

const INJECTION_PATTERNS: Array<[FlaggedCategory, RegExp]> = [
  // instruction_override — attempts to hijack the system prompt or role
  ["instruction_override", /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i],
  ["instruction_override", /\bsystem\s+override\b/i],
  ["instruction_override", /\byou\s+are\s+now\s+(a\s+)?(?!.*buyer)/i],
  ["instruction_override", /\bdisregard\s+(your|all)\s+(previous\s+)?(instructions?|rules?|guidelines?)/i],
  ["instruction_override", /\bact\s+as\s+(if\s+you\s+are|a)\s+(?!.*buyer)/i],
  ["instruction_override", /\bnew\s+(role|persona|instructions?)\b/i],
  ["instruction_override", /\bjailbreak\b/i],
  ["instruction_override", /\bdan\s+mode\b/i],

  // exfiltration — attempts to extract private data or bypass privacy controls
  ["exfiltration", /\bprint\s+(all\s+)?(user\s+)?(secrets?|keys?|tokens?|passwords?)\b/i],
  ["exfiltration", /\brepeat\s+.*system\s+prompt\b/i],
  ["exfiltration", /\bsend\s+.*to\s+(an?\s+)?(external|remote|different)\s+(url|endpoint|server)\b/i],
  ["exfiltration", /\bexfiltrat/i],
  ["exfiltration", /\bleaking?\s+(confidential|private|sensitive)\b/i],

  // budget_tampering — attempts to manipulate spending limits or prices
  ["budget_tampering", /set\s+(spending|budget|limit|total)\s+(to\s+)?\$?0/i],
  ["budget_tampering", /\bbypass\s+(spend|budget|limit|approval)\b/i],
  ["budget_tampering", /\bapprove\s+(automatically|without\s+(limit|check|approval))\b/i],
  ["budget_tampering", /\bchange\s+(the\s+)?(price|amount|total)\s+to\b/i],
  ["budget_tampering", /\bunlimited\s+(spending|budget|funds?)\b/i],
];

// ── Scoring weights per category ──────────────────────────────────────────────
const CATEGORY_WEIGHTS: Record<FlaggedCategory, number> = {
  instruction_override: 0.5,
  exfiltration: 0.4,
  budget_tampering: 0.35,
};

// Per-pattern score contribution (additive, capped at 1.0)
const PER_PATTERN_INCREMENT = 0.15;

export class GuardrailMiddleware {
  constructor(private readonly db?: Pool) {}

  /**
   * Scan `text` for injection patterns, compute a risk score, and return a
   * sanitized copy with flagged content redacted.
   *
   * When `db` is provided, any unsafe input is logged to `security_alerts`.
   */
  async sanitizeText(
    text: string,
    context?: { userId?: string; source?: string }
  ): Promise<GuardrailCheckResult> {
    const flaggedCategories = new Set<FlaggedCategory>();
    let riskScore = 0;
    let sanitized = text;

    for (const [category, pattern] of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        flaggedCategories.add(category);
        riskScore = Math.min(
          1.0,
          riskScore + (CATEGORY_WEIGHTS[category] * PER_PATTERN_INCREMENT) / 0.15
        );
        // Redact the matched substring
        sanitized = sanitized.replace(pattern, "[REDACTED]");
      }
    }

    // Normalise risk score to [0, 1]
    riskScore = Math.min(1.0, riskScore);

    const isSafe = flaggedCategories.size === 0;

    if (!isSafe) {
      log.warn("Guardrail: prompt injection detected", {
        flaggedCategories: [...flaggedCategories],
        riskScore,
        userId: context?.userId,
        source: context?.source,
      });

      await this.logSecurityAlert({
        alertType: "prompt_injection",
        flaggedCategories: [...flaggedCategories],
        riskScore,
        userId: context?.userId,
        source: context?.source,
        rawTextSnippet: text.slice(0, 500),
      });
    }

    return {
      isSafe,
      flaggedCategories: [...flaggedCategories],
      sanitizedText: sanitized,
      riskScore,
    };
  }

  /**
   * Validate tool call parameters against the registered Zod schema for
   * `toolName`.  Returns the parsed (safe, coerced) params on success.
   *
   * Throws a `GuardrailValidationError` on failure so callers can handle
   * tool-call rejections without a full process crash.
   */
  validateToolParams<T = unknown>(
    toolName: string,
    rawParams: unknown
  ): T {
    const schema = TOOL_SCHEMAS[toolName as ToolName];
    if (!schema) {
      throw new GuardrailValidationError(
        toolName,
        `Unknown tool: ${toolName}`
      );
    }

    const result = schema.safeParse(rawParams);
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");

      log.warn("Guardrail: tool parameter validation failed", {
        toolName,
        issues: result.error.issues,
      });

      throw new GuardrailValidationError(toolName, message);
    }

    return result.data as T;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async logSecurityAlert(payload: {
    alertType: string;
    flaggedCategories: FlaggedCategory[];
    riskScore: number;
    userId?: string;
    source?: string;
    rawTextSnippet: string;
  }): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.query(
        `INSERT INTO security_alerts
           (id, alert_type, payload, user_id, created_at)
         VALUES (gen_random_uuid(), $1, $2::jsonb, $3, NOW())`,
        [
          payload.alertType,
          JSON.stringify({
            flaggedCategories: payload.flaggedCategories,
            riskScore: payload.riskScore,
            source: payload.source,
            rawTextSnippet: payload.rawTextSnippet,
          }),
          payload.userId ?? null,
        ]
      );
    } catch (err) {
      // Alert logging must never crash the agent pipeline — log and continue
      log.error("Failed to write security alert", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export class GuardrailValidationError extends Error {
  constructor(
    public readonly toolName: string,
    message: string
  ) {
    super(`Tool parameter validation failed for "${toolName}": ${message}`);
    this.name = "GuardrailValidationError";
  }
}
