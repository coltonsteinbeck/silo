-- Fix: Remove composite indexes that INCLUDE embedding vectors
-- BTree indexes cannot include vector columns due to page size limits (max 2704 bytes)
-- The HNSW indexes on embedding columns are sufficient for vector search
-- Filtering by context_type can use a separate simple index

-- Drop the problematic indexes
DROP INDEX IF EXISTS idx_user_memory_context_embedding;
DROP INDEX IF EXISTS idx_server_memory_context_embedding;

-- Create simple indexes for context_type filtering (no embedding)
-- These will be used in combination with the HNSW embedding indexes
CREATE INDEX IF NOT EXISTS idx_user_memory_context_type
ON user_memory (context_type);

CREATE INDEX IF NOT EXISTS idx_server_memory_context_type
ON server_memory (context_type);
