/**
 * User Memory types — Issue #266
 */

export type MemoryCategory = "preference" | "constraint" | "address";

export interface UserMemoryItem {
  id: string;
  userId: string;
  category: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
}

export interface UpsertMemoryInput {
  userId: string;
  category: MemoryCategory;
  key: string;
  value: string;
  /** 1536-dim embedding vector from the embedding model (optional; stored as null when unavailable). */
  embedding?: number[];
  /** Confidence in [0.0, 1.0]. Defaults to 1.0. */
  confidence?: number;
}

export interface MemorySearchOptions {
  /** Limit results (default: 5). */
  limit?: number;
  /** Filter by category. */
  category?: MemoryCategory;
}
