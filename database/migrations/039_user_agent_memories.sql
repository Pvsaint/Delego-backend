-- Migration: 039_user_agent_memories
-- Issue: #266 Long-Term User Preference Memory in PostgreSQL
-- Description: Adds user_agent_memories table with a pgvector embedding
--              column and an IVFFLAT cosine-similarity index.

-- Requires the pgvector extension.  Install once per database:
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS user_agent_memories (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   VARCHAR(32) NOT NULL
               CHECK (category IN ('preference', 'constraint', 'address')),
  key        VARCHAR(64) NOT NULL,
  value      TEXT        NOT NULL,
  embedding  vector(1536),
  confidence REAL        NOT NULL DEFAULT 1.0
               CHECK (confidence BETWEEN 0.0 AND 1.0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint: one value per (user, category, key) — upsert key
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_agent_memories_unique_key
  ON user_agent_memories (user_id, category, key);

-- Lookup by user
CREATE INDEX IF NOT EXISTS idx_user_agent_memories_user_id
  ON user_agent_memories (user_id);

-- IVFFLAT cosine-similarity index for vector KNN search.
-- lists = 100 is a reasonable starting value for tens-of-thousands of rows.
-- Re-index with a higher `lists` value as the table grows.
-- Note: index is only useful once the table has data.
CREATE INDEX IF NOT EXISTS idx_user_agent_memories_embedding
  ON user_agent_memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX  IF EXISTS idx_user_agent_memories_embedding;
-- DROP INDEX  IF EXISTS idx_user_agent_memories_user_id;
-- DROP INDEX  IF EXISTS idx_user_agent_memories_unique_key;
-- DROP TABLE  IF EXISTS user_agent_memories;
