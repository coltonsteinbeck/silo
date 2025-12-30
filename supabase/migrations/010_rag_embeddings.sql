-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding columns to user_memory table
-- Using 1536 dimensions to match OpenAI's text-embedding-3-small model
ALTER TABLE user_memory
ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Add embedding column to server_memory table
ALTER TABLE server_memory
ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create indices for efficient vector similarity search
-- HNSW index is preferred for high-dimensional vectors (>100 dimensions)
-- Uses cosine distance for semantic similarity
CREATE INDEX IF NOT EXISTS idx_user_memory_embedding
ON user_memory USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_server_memory_embedding
ON server_memory USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Composite index for efficient filtering by context_type + embedding search
CREATE INDEX IF NOT EXISTS idx_user_memory_context_embedding
ON user_memory (context_type)
INCLUDE (embedding);

CREATE INDEX IF NOT EXISTS idx_server_memory_context_embedding
ON server_memory (context_type)
INCLUDE (embedding);

-- Function to search user memories by semantic similarity
-- Uses cosine distance (1 - cosine_similarity) for ranking
-- Returns memories ordered by relevance with similarity scores
CREATE OR REPLACE FUNCTION search_user_memories_by_embedding(
  p_user_id UUID,
  p_embedding vector(1536),
  p_context_type TEXT DEFAULT NULL,
  p_limit INT DEFAULT 10,
  p_similarity_threshold FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  id UUID,
  memory_content TEXT,
  context_type TEXT,
  similarity FLOAT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    um.id,
    um.memory_content,
    um.context_type,
    (1 - (um.embedding <=> p_embedding))::FLOAT as similarity,
    um.expires_at,
    um.created_at
  FROM user_memory um
  WHERE
    um.user_id = p_user_id
    AND (p_context_type IS NULL OR um.context_type = p_context_type)
    AND um.embedding IS NOT NULL
    AND (1 - (um.embedding <=> p_embedding)) >= p_similarity_threshold
    AND (um.expires_at IS NULL OR um.expires_at > NOW())
  ORDER BY um.embedding <=> p_embedding
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to search server memories by semantic similarity
CREATE OR REPLACE FUNCTION search_server_memories_by_embedding(
  p_server_id UUID,
  p_embedding vector(1536),
  p_context_type TEXT DEFAULT NULL,
  p_limit INT DEFAULT 10,
  p_similarity_threshold FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  id UUID,
  memory_content TEXT,
  context_type TEXT,
  similarity FLOAT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.id,
    sm.memory_content,
    sm.context_type,
    (1 - (sm.embedding <=> p_embedding))::FLOAT as similarity,
    sm.expires_at,
    sm.created_at
  FROM server_memory sm
  WHERE
    sm.server_id = p_server_id
    AND (p_context_type IS NULL OR sm.context_type = p_context_type)
    AND sm.embedding IS NOT NULL
    AND (1 - (sm.embedding <=> p_embedding)) >= p_similarity_threshold
    AND (sm.expires_at IS NULL OR sm.expires_at > NOW())
  ORDER BY sm.embedding <=> p_embedding
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to perform hybrid search combining keyword and semantic search
-- Returns union of text-based ILIKE results and embedding-based results
-- Useful for finding relevant memories even with partial text matches
CREATE OR REPLACE FUNCTION search_user_memories_hybrid(
  p_user_id UUID,
  p_query TEXT,
  p_embedding vector(1536) DEFAULT NULL,
  p_context_type TEXT DEFAULT NULL,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  memory_content TEXT,
  context_type TEXT,
  similarity FLOAT,
  search_method TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  -- Return semantic results if embedding provided
  IF p_embedding IS NOT NULL THEN
    RETURN QUERY
    SELECT
      um.id,
      um.memory_content,
      um.context_type,
      (1 - (um.embedding <=> p_embedding))::FLOAT,
      'semantic'::TEXT,
      um.expires_at,
      um.created_at
    FROM user_memory um
    WHERE
      um.user_id = p_user_id
      AND (p_context_type IS NULL OR um.context_type = p_context_type)
      AND um.embedding IS NOT NULL
      AND (um.expires_at IS NULL OR um.expires_at > NOW())
    ORDER BY um.embedding <=> p_embedding
    LIMIT p_limit;
  ELSE
    -- Fall back to text search if no embedding provided
    RETURN QUERY
    SELECT
      um.id,
      um.memory_content,
      um.context_type,
      NULL::FLOAT,
      'text'::TEXT,
      um.expires_at,
      um.created_at
    FROM user_memory um
    WHERE
      um.user_id = p_user_id
      AND (p_context_type IS NULL OR um.context_type = p_context_type)
      AND um.memory_content ILIKE '%' || p_query || '%'
      AND (um.expires_at IS NULL OR um.expires_at > NOW())
    ORDER BY um.created_at DESC
    LIMIT p_limit;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update embeddings on memory updates
-- (Implementation depends on whether embeddings are generated in app or via trigger)
-- For now, app is responsible for generating embeddings via OpenAI provider
-- Future: Could add a trigger to flag memories as needing embedding generation

-- Add comment documenting vector search configuration
COMMENT ON INDEX idx_user_memory_embedding IS 'HNSW vector index for cosine similarity search on user memory embeddings. Cost-optimized with m=16, ef_construction=64.';
COMMENT ON INDEX idx_server_memory_embedding IS 'HNSW vector index for cosine similarity search on server memory embeddings. Cost-optimized with m=16, ef_construction=64.';
COMMENT ON FUNCTION search_user_memories_by_embedding IS 'Search user memories by semantic similarity using vector embeddings. Returns ranked results ordered by relevance.';
COMMENT ON FUNCTION search_server_memories_by_embedding IS 'Search server memories by semantic similarity using vector embeddings. Returns ranked results ordered by relevance.';
COMMENT ON FUNCTION search_user_memories_hybrid IS 'Hybrid search combining semantic and text-based search for user memories. Falls back to ILIKE when embedding not provided.';
