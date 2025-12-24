-- Enable UUID extension
CREATE EXTENSION
IF NOT EXISTS "uuid-ossp";

-- User memory table
CREATE TABLE
IF NOT EXISTS user_memory
(
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4
(),
    user_id TEXT NOT NULL,
    memory_content TEXT NOT NULL,
    context_type TEXT NOT NULL CHECK
(context_type IN
('conversation', 'preference', 'summary', 'temporary', 'mood')),
    metadata JSONB DEFAULT '{}',
    expires_at TIMESTAMP
WITH TIME ZONE,
    created_at TIMESTAMP
WITH TIME ZONE DEFAULT NOW
(),
    updated_at TIMESTAMP
WITH TIME ZONE DEFAULT NOW
()
);

CREATE INDEX
IF NOT EXISTS idx_user_memory_user_id ON user_memory
(user_id);
CREATE INDEX
IF NOT EXISTS idx_user_memory_context_type ON user_memory
(context_type);
CREATE INDEX
IF NOT EXISTS idx_user_memory_expires_at ON user_memory
(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX
IF NOT EXISTS idx_user_memory_created_at ON user_memory
(created_at DESC);

-- Server memory table
CREATE TABLE
IF NOT EXISTS server_memory
(
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4
(),
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    memory_content TEXT NOT NULL,
    title TEXT,
    context_type TEXT DEFAULT 'server_knowledge',
    metadata JSONB DEFAULT '{}',
    expires_at TIMESTAMP
WITH TIME ZONE,
    created_at TIMESTAMP
WITH TIME ZONE DEFAULT NOW
(),
    updated_at TIMESTAMP
WITH TIME ZONE DEFAULT NOW
()
);

CREATE INDEX
IF NOT EXISTS idx_server_memory_server_id ON server_memory
(server_id);
CREATE INDEX
IF NOT EXISTS idx_server_memory_context_type ON server_memory
(context_type);
CREATE INDEX
IF NOT EXISTS idx_server_memory_created_at ON server_memory
(created_at DESC);

-- User preferences table
CREATE TABLE
IF NOT EXISTS user_preferences
(
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMP
WITH TIME ZONE DEFAULT NOW
(),
    updated_at TIMESTAMP
WITH TIME ZONE DEFAULT NOW
(),
    PRIMARY KEY
(user_id, key)
);

CREATE INDEX
IF NOT EXISTS idx_user_preferences_user_id ON user_preferences
(user_id);

-- Conversation history table
CREATE TABLE
IF NOT EXISTS conversation_messages
(
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4
(),
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK
(role IN
('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMP
WITH TIME ZONE DEFAULT NOW
()
);

CREATE INDEX
IF NOT EXISTS idx_conversation_channel_id ON conversation_messages
(channel_id);
CREATE INDEX
IF NOT EXISTS idx_conversation_created_at ON conversation_messages
(created_at DESC);

-- Trigger to update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column
()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW
();
RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_memory_updated_at
ON user_memory;
CREATE TRIGGER update_user_memory_updated_at BEFORE
UPDATE ON user_memory
    FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column
();

DROP TRIGGER IF EXISTS update_server_memory_updated_at
ON server_memory;
CREATE TRIGGER update_server_memory_updated_at BEFORE
UPDATE ON server_memory
    FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column
();

DROP TRIGGER IF EXISTS update_user_preferences_updated_at
ON user_preferences;
CREATE TRIGGER update_user_preferences_updated_at BEFORE
UPDATE ON user_preferences
    FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column
();
