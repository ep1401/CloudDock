-- Stores AWS authentication sessions (persists beyond VS Code sessions)
CREATE TABLE aws_sessions (
    aws_id TEXT PRIMARY KEY  -- Unique AWS account identifier (e.g., aws-123456789012)
);

-- Stores AWS instances and their optional group assignment
CREATE TABLE aws_instances (
    instance_id TEXT PRIMARY KEY,  -- Unique AWS instance ID (e.g., i-0abcd1234)
    aws_id TEXT REFERENCES aws_sessions(aws_id),  -- Link to AWS session (no cascade deletion)
    group_id TEXT  -- Group ID for batch shutdown (NULL if not in a group)
);

-- Stores Azure authentication sessions (persists beyond VS Code sessions)
CREATE TABLE azure_sessions (
    azure_id TEXT PRIMARY KEY  -- Unique Azure account identifier (e.g., azure-user@example.com)
);

-- Stores Azure instances and their optional group assignment
CREATE TABLE azure_instances (
    instance_id TEXT PRIMARY KEY,  -- Unique Azure instance ID
    azure_id TEXT REFERENCES azure_sessions(azure_id),  -- Link to Azure session (no cascade deletion)
    group_id TEXT  -- Group ID for batch shutdown (NULL if not in a group)
);
