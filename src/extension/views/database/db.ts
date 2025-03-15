import { Pool } from "pg";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Create a PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for AWS RDS if SSL is enforced
  },
});

// Test the connection
pool.connect()
  .then(client => {
    console.log("🚀 Connected to AWS PostgreSQL!");
    client.release();
  })
  .catch(err => console.error("❌ Database connection error:", err.stack));

export const query = (text: string, params?: any[]) => pool.query(text, params);

/**
 * Creates a new instance group and assigns instances to it.
 * Ensures no instance is already in a group and verifies user ownership.
 */
export const createInstanceGroup = async (
  provider: "aws" | "azure" | "both",
  userId: string,
  newGroupName: string,
  instanceList: { aws?: string[]; azure?: string[] } // Object with separate AWS & Azure instances
): Promise<string> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN"); // Start transaction

    // Validate instance lists
    const awsInstances = instanceList.aws || [];
    const azureInstances = instanceList.azure || [];
    const useAWS = provider === "aws" || provider === "both";
    const useAzure = provider === "azure" || provider === "both";

    // Check if any AWS instances are already in a group
    if (useAWS && awsInstances.length > 0) {
      const { rows: existingAWSGroups } = await client.query(
        "SELECT instance_id FROM aws_instances WHERE instance_id = ANY($1) AND group_id IS NOT NULL",
        [awsInstances]
      );
      if (existingAWSGroups.length > 0) {
        const groupedInstances = existingAWSGroups.map(row => row.instance_id).join(", ");
        throw new Error(`❌ AWS Instances already in a group: ${groupedInstances}`);
      }
    }

    // Check if any Azure instances are already in a group
    if (useAzure && azureInstances.length > 0) {
      const { rows: existingAzureGroups } = await client.query(
        "SELECT instance_id FROM azure_instances WHERE instance_id = ANY($1) AND group_id IS NOT NULL",
        [azureInstances]
      );
      if (existingAzureGroups.length > 0) {
        const groupedInstances = existingAzureGroups.map(row => row.instance_id).join(", ");
        throw new Error(`❌ Azure Instances already in a group: ${groupedInstances}`);
      }
    }

    // Create the new group
    const { rows } = await client.query(
      "INSERT INTO instance_groups (group_name) VALUES ($1) RETURNING group_id",
      [newGroupName]
    );
    const newGroupId = rows[0].group_id;

    // Assign AWS instances to the group
    if (useAWS && awsInstances.length > 0) {
      await client.query(
        "UPDATE aws_instances SET group_id = $1 WHERE instance_id = ANY($2) AND aws_id = $3",
        [newGroupId, awsInstances, userId]
      );

      // Update AWS user session with the new group
      await client.query(
        "UPDATE aws_sessions SET group_ids = array_append(group_ids, $1) WHERE aws_id = $2",
        [newGroupId, userId]
      );
    }

    // Assign Azure instances to the group
    if (useAzure && azureInstances.length > 0) {
      await client.query(
        "UPDATE azure_instances SET group_id = $1 WHERE instance_id = ANY($2) AND azure_id = $3",
        [newGroupId, azureInstances, userId]
      );

      // Update Azure user session with the new group
      await client.query(
        "UPDATE azure_sessions SET group_ids = array_append(group_ids, $1) WHERE azure_id = $2",
        [newGroupId, userId]
      );
    }

    await client.query("COMMIT"); // Commit transaction
    return `✅ Group created successfully with ID: ${newGroupId}`;
  } catch (err) {
    await client.query("ROLLBACK"); // Rollback transaction on error
    return `❌ Error creating group: ${err}`;
  } finally {
    client.release(); // Release client back to the pool
  }
};


/**
 * Adds instances to an existing group.
 * Ensures instances are not already in a different group and verifies user ownership.
 */
export const addInstancesToGroup = async (
  provider: "aws" | "azure" | "both",
  userId: string,
  groupId: string,
  instanceList: { aws?: string[]; azure?: string[] } // Separate AWS & Azure instance lists
): Promise<string> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN"); // Start transaction

    // Validate instance lists
    const awsInstances = instanceList.aws || [];
    const azureInstances = instanceList.azure || [];
    const useAWS = provider === "aws" || provider === "both";
    const useAzure = provider === "azure" || provider === "both";

    // Check if the group exists
    const { rowCount: groupExists } = await client.query(
      "SELECT 1 FROM instance_groups WHERE group_id = $1",
      [groupId]
    );
    if (groupExists === 0) {
      throw new Error(`❌ Group ID ${groupId} does not exist.`);
    }

    // Check if any AWS instances are already in a different group
    if (useAWS && awsInstances.length > 0) {
      const { rows: existingAWSGroups } = await client.query(
        "SELECT instance_id FROM aws_instances WHERE instance_id = ANY($1) AND group_id IS NOT NULL",
        [awsInstances]
      );
      if (existingAWSGroups.length > 0) {
        const groupedInstances = existingAWSGroups.map(row => row.instance_id).join(", ");
        throw new Error(`❌ AWS Instances already in a group: ${groupedInstances}`);
      }
    }

    // Check if any Azure instances are already in a different group
    if (useAzure && azureInstances.length > 0) {
      const { rows: existingAzureGroups } = await client.query(
        "SELECT instance_id FROM azure_instances WHERE instance_id = ANY($1) AND group_id IS NOT NULL",
        [azureInstances]
      );
      if (existingAzureGroups.length > 0) {
        const groupedInstances = existingAzureGroups.map(row => row.instance_id).join(", ");
        throw new Error(`❌ Azure Instances already in a group: ${groupedInstances}`);
      }
    }

    let updatedRows = 0;

    // Assign AWS instances to the group
    if (useAWS && awsInstances.length > 0) {
      const { rowCount } = await client.query(
        "UPDATE aws_instances SET group_id = $1 WHERE instance_id = ANY($2) AND aws_id = $3",
        [groupId, awsInstances, userId]
      );
      updatedRows += rowCount ?? 0;

      // Update AWS user session with the group
      await client.query(
        "UPDATE aws_sessions SET group_ids = array_append(group_ids, $1) WHERE aws_id = $2 AND NOT ($1 = ANY(group_ids))",
        [groupId, userId]
      );
    }

    // Assign Azure instances to the group
    if (useAzure && azureInstances.length > 0) {
      const { rowCount } = await client.query(
        "UPDATE azure_instances SET group_id = $1 WHERE instance_id = ANY($2) AND azure_id = $3",
        [groupId, azureInstances, userId]
      );
      updatedRows += rowCount ?? 0;

      // Update Azure user session with the group
      await client.query(
        "UPDATE azure_sessions SET group_ids = array_append(group_ids, $1) WHERE azure_id = $2 AND NOT ($1 = ANY(group_ids))",
        [groupId, userId]
      );
    }

    if (updatedRows === 0) {
      throw new Error(`❌ No instances were updated. Ensure you own these instances.`);
    }

    await client.query("COMMIT"); // Commit transaction
    return `✅ Successfully added ${updatedRows} instance(s) to group ${groupId}.`;
  } catch (err) {
    await client.query("ROLLBACK"); // Rollback on error
    return `❌ Error adding instances to group: ${err}`;
  } finally {
    client.release(); // Release client back to the pool
  }
};

export const removeInstanceFromGroup = async (
  provider: "aws" | "azure" | "both",
  userId: string,
  groupId: string,
  instanceList: { aws?: string[]; azure?: string[] } // Separate AWS & Azure instance lists
): Promise<string> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN"); // Start transaction

    // Validate instance lists
    const awsInstances = instanceList.aws || [];
    const azureInstances = instanceList.azure || [];
    const useAWS = provider === "aws" || provider === "both";
    const useAzure = provider === "azure" || provider === "both";

    let removedRows = 0;

    // Remove AWS instances from the group
    if (useAWS && awsInstances.length > 0) {
      const { rowCount } = await client.query(
        "UPDATE aws_instances SET group_id = NULL WHERE instance_id = ANY($1) AND aws_id = $2 AND group_id = $3",
        [awsInstances, userId, groupId]
      );
      removedRows += rowCount ?? 0;
    }

    // Remove Azure instances from the group
    if (useAzure && azureInstances.length > 0) {
      const { rowCount } = await client.query(
        "UPDATE azure_instances SET group_id = NULL WHERE instance_id = ANY($1) AND azure_id = $2 AND group_id = $3",
        [azureInstances, userId, groupId]
      );
      removedRows += rowCount ?? 0;
    }

    if (removedRows === 0) {
      throw new Error(`❌ No instances were removed. Ensure you own these instances and they are in the correct group.`);
    }

    // Check if any instances still belong to the group
    const { rowCount: remainingInstances } = await client.query(
      "SELECT 1 FROM aws_instances WHERE group_id = $1 UNION ALL SELECT 1 FROM azure_instances WHERE group_id = $1",
      [groupId]
    );

    // If no more instances are part of this group, remove it from the user's `group_ids[]`
    if (remainingInstances === 0) {
      await client.query(
        "UPDATE aws_sessions SET group_ids = array_remove(group_ids, $1) WHERE aws_id = $2",
        [groupId, userId]
      );
      await client.query(
        "UPDATE azure_sessions SET group_ids = array_remove(group_ids, $1) WHERE azure_id = $2",
        [groupId, userId]
      );
    }

    await client.query("COMMIT"); // Commit transaction
    return `✅ Successfully removed ${removedRows} instance(s) from group ${groupId}.`;
  } catch (err) {
    await client.query("ROLLBACK"); // Rollback on error
    return `❌ Error removing instances from group: ${err}`;
  } finally {
    client.release(); // Release client back to the pool
  }
};

export const getInstancesFromGroup = async (
  provider: "aws" | "azure" | "both",
  groupId: string
): Promise<{ aws?: string[]; azure?: string[] } | string> => {
  const client = await pool.connect();

  try {
    let awsInstances: string[] = [];
    let azureInstances: string[] = [];

    // Fetch AWS instances from the group
    if (provider === "aws" || provider === "both") {
      const { rows } = await client.query(
        "SELECT instance_id FROM aws_instances WHERE group_id = $1",
        [groupId]
      );
      awsInstances = rows.map(row => row.instance_id);
    }

    // Fetch Azure instances from the group
    if (provider === "azure" || provider === "both") {
      const { rows } = await client.query(
        "SELECT instance_id FROM azure_instances WHERE group_id = $1",
        [groupId]
      );
      azureInstances = rows.map(row => row.instance_id);
    }

    // Check if no instances were found
    if (awsInstances.length === 0 && azureInstances.length === 0) {
      return `❌ No instances found for group ID: ${groupId}`;
    }

    return { aws: awsInstances.length ? awsInstances : undefined, azure: azureInstances.length ? azureInstances : undefined };
  } catch (err) {
    return `❌ Error retrieving instances from group: ${err}`;
  } finally {
    client.release(); // Release client back to the pool
  }
};

