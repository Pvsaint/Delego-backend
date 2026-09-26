/**
 * Agent Session Manager — Issue #268
 *
 * Manages multi-turn conversation context in Redis with a 24-hour sliding
 * TTL and a windowing function that truncates conversation history when
 * token consumption approaches the model context limit.
 *
 * Windowing strategy:
 *   - The system message (role === "system") is always preserved.
 *   - When `totalTokensConsumed` exceeds `maxContextTokens`, the oldest
 *     user/assistant message pairs are dropped first — until the remaining
 *     messages' estimated token count fits within the budget.
 *   - Each message's token count is estimated at 4 chars ≈ 1 token (GPT-4
 *     rough approximation — replace with tiktoken for precision).
 */
import { createLogger, generateId } from "@delegolabs/utils";
import type { CacheRedisClient } from "@delegolabs/cache";
import type {
  AgentSessionState,
  AppendMessageInput,
  CreateSessionInput,
  LLMMessage,
} from "./types.js";

const log = createLogger(
  "buyer-agent:session",
  process.env.LOG_LEVEL ?? "info"
);

/** Default context token budget before windowing kicks in (≈ GPT-4 32k). */
const DEFAULT_MAX_CONTEXT_TOKENS = Number(
  process.env.AGENT_MAX_CONTEXT_TOKENS ?? 28_000
);

/** 24 hours in seconds */
const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** Rough token estimator: 4 chars ≈ 1 token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: LLMMessage[]): number {
  return messages.reduce(
    (acc, m) => acc + estimateTokens(m.content) + 4, // +4 for role/separator overhead
    0
  );
}

export class SessionManager {
  private readonly maxContextTokens: number;

  constructor(
    private readonly redis: CacheRedisClient,
    maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS
  ) {
    this.maxContextTokens = maxContextTokens;
  }

  /**
   * Create a new session and persist it to Redis.
   * Returns the initial `AgentSessionState`.
   */
  async createSession(input: CreateSessionInput): Promise<AgentSessionState> {
    const sessionId = generateId();
    const now = Date.now();

    const initialMessages: LLMMessage[] = input.systemPrompt
      ? [{ role: "system", content: input.systemPrompt }]
      : [];

    const state: AgentSessionState = {
      sessionId,
      userId: input.userId,
      agentId: input.agentId,
      messages: initialMessages,
      lastActiveAt: now,
      totalTokensConsumed: 0,
    };

    await this.saveSession(state);
    log.info("Session created", { sessionId, userId: input.userId });
    return state;
  }

  /**
   * Load a session from Redis.
   * Returns `null` if the session does not exist or has expired.
   */
  async getSession(sessionId: string): Promise<AgentSessionState | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as AgentSessionState;
    } catch {
      log.warn("Corrupt session data — evicting", { sessionId });
      await this.redis.del(this.key(sessionId));
      return null;
    }
  }

  /**
   * Append a message to the session and slide the TTL.
   *
   * After appending, if the estimated token count exceeds `maxContextTokens`,
   * `applyWindowingPolicy` trims the oldest non-system messages until the
   * budget is respected.
   */
  async appendMessage(input: AppendMessageInput): Promise<AgentSessionState> {
    const state = await this.getSession(input.sessionId);
    if (!state) {
      throw new SessionNotFoundError(input.sessionId);
    }

    state.messages.push(input.message);
    state.totalTokensConsumed += input.tokensConsumed ?? estimateTokens(input.message.content);
    state.lastActiveAt = Date.now();

    const windowed = this.applyWindowingPolicy(state);
    await this.saveSession(windowed);
    return windowed;
  }

  /**
   * Update the active proposal ID attached to this session (e.g., when the
   * agent generates a purchase proposal mid-conversation).
   */
  async setActiveProposal(
    sessionId: string,
    proposalId: string | undefined
  ): Promise<void> {
    const state = await this.getSession(sessionId);
    if (!state) throw new SessionNotFoundError(sessionId);

    state.activeProposalId = proposalId;
    state.lastActiveAt = Date.now();
    await this.saveSession(state);
  }

  /**
   * Delete a session — called on explicit user logout or after a completed
   * purchase flow to free Redis memory early.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId));
    log.info("Session deleted", { sessionId });
  }

  // ── Windowing ────────────────────────────────────────────────────────────────

  /**
   * Trim the oldest user/assistant messages until estimated token count
   * fits within `maxContextTokens`.  The system message is always kept.
   *
   * This preserves coherence (recent context) while honoring model limits.
   */
  applyWindowingPolicy(state: AgentSessionState): AgentSessionState {
    const systemMessages = state.messages.filter((m) => m.role === "system");
    let conversationMessages = state.messages.filter((m) => m.role !== "system");

    while (conversationMessages.length > 0) {
      const totalEstimate = estimateMessagesTokens([
        ...systemMessages,
        ...conversationMessages,
      ]);

      if (totalEstimate <= this.maxContextTokens) break;

      // Drop the oldest non-system message
      conversationMessages = conversationMessages.slice(1);

      log.debug("Session windowing: dropped oldest message", {
        sessionId: state.sessionId,
        remainingMessages: conversationMessages.length,
        estimatedTokens: totalEstimate,
      });
    }

    return {
      ...state,
      messages: [...systemMessages, ...conversationMessages],
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private key(sessionId: string): string {
    return `agent:session:${sessionId}`;
  }

  private async saveSession(state: AgentSessionState): Promise<void> {
    await this.redis.set(
      this.key(state.sessionId),
      JSON.stringify(state),
      "EX",
      SESSION_TTL_SECONDS
    );
  }
}

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Agent session "${sessionId}" not found or has expired`);
    this.name = "SessionNotFoundError";
  }
}
