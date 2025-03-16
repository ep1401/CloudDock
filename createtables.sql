-- Enable the pgcrypto extension for UUID generation (PostgreSQL only)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Stores unique instance groups (ensures global uniqueness of group names)
CREATE TABLE instance_groups (
    group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Auto-generates a unique UUID
    group_name TEXT UNIQUE NOT NULL -- Ensures names are unique across AWS & Azure
);

-- Stores AWS authentication sessions (persists beyond VS Code sessions)
CREATE TABLE aws_sessions (
    aws_id TEXT PRIMARY KEY,  -- Unique AWS account identifier (e.g., aws-123456789012)
    group_ids UUID[] DEFAULT '{}'  -- Array of group IDs the user has access to
);

-- Stores AWS instances and their optional group assignment
CREATE TABLE aws_instances (
    instance_id TEXT PRIMARY KEY,  -- Unique AWS instance ID (e.g., i-0abcd1234)
    aws_id TEXT REFERENCES aws_sessions(aws_id),  -- Ensures instances belong to a valid session
    group_id UUID REFERENCES instance_groups(group_id),  -- Assigns the instance to a group
    group_name TEXT NOT NULL  -- Stores the group name directly
);

-- Stores Azure authentication sessions (persists beyond VS Code sessions)
CREATE TABLE azure_sessions (
    azure_id TEXT PRIMARY KEY,  -- Unique Azure account identifier (e.g., azure-user@example.com)
    group_ids UUID[] DEFAULT '{}'  -- Array of group IDs the user has access to
);

-- Stores Azure instances and their optional group assignment
CREATE TABLE azure_instances (
    instance_id TEXT PRIMARY KEY,  -- Unique Azure instance ID (e.g., azure-56789)
    azure_id TEXT REFERENCES azure_sessions(azure_id),  -- Ensures instances belong to a valid session
    group_id UUID REFERENCES instance_groups(group_id),  -- Assigns the instance to a group
    group_name TEXT NOT NULL  -- Stores the group name directly
);

-- Stores scheduled downtime for instance groups
CREATE TABLE group_downtime (
    group_id UUID PRIMARY KEY REFERENCES instance_groups(group_id) ON DELETE CASCADE, -- Associates downtime with a specific group
    start_time TIMESTAMP NOT NULL, -- Start time of the scheduled downtime
    end_time TIMESTAMP NOT NULL, -- End time of the scheduled downtime
    CHECK (end_time > start_time) -- Ensures end time is after start time
);

