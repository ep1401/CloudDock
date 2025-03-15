import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';

dotenv.config(); // Load environment variables

// Initialize Supabase
const supabaseUrl = "https://lhvuliyyfavdoevigjwl.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxodnVsaXl5ZmF2ZG9ldmlnandsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDIwNjk3MzksImV4cCI6MjA1NzY0NTczOX0.BYK8g5pHX--8E0LvBhslgZdPei8h_SMEjyhsSvajq5s";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const createInstanceGroup = async (
  provider: "aws" | "azure" | "both",
  userId: string,
  groupName: string,
  instanceList: { aws?: string[]; azure?: string[] }
): Promise<string> => {
  try {
    // Determine the appropriate table names
    const sessionTable = provider === "aws" ? "aws_sessions" : "azure_sessions";
    const instanceTable = provider === "aws" ? "aws_instances" : "azure_instances";
    const sessionColumn = provider === "aws" ? "aws_id" : "azure_id";

    // ✅ Step 1: Check if the group already exists
    const { data: existingGroup, error: groupError } = await supabase
      .from("instance_groups")
      .select("group_id")
      .eq("group_name", groupName)
      .maybeSingle();

    if (groupError) {
      throw new Error(`Error checking group name: ${groupError.message}`);
    }

    if (existingGroup) {
      // ❌ If group already exists, return an error
      throw new Error(`A group with the name '${groupName}' already exists. Please choose a different name.`);
    }

    // ✅ Step 2: Create the new group
    const groupId = uuidv4();
    const { error: insertGroupError } = await supabase
      .from("instance_groups")
      .insert([{ group_id: groupId, group_name: groupName }]);

    if (insertGroupError) {
      throw new Error(`Error creating group: ${insertGroupError.message}`);
    }

    // ✅ Step 3: Ensure the user session exists and add the group ID
    const { data: sessionData, error: sessionError } = await supabase
      .from(sessionTable)
      .select("group_ids")
      .eq(sessionColumn, userId)
      .maybeSingle();

    if (sessionError) {
      throw new Error(`Error fetching session data from ${sessionTable}: ${sessionError.message}`);
    }

    let updatedGroupIds = sessionData ? [...new Set([...sessionData.group_ids, groupId])] : [groupId];

    if (sessionData) {
      // Update existing session with new group ID
      const { error: updateSessionError } = await supabase
        .from(sessionTable)
        .update({ group_ids: updatedGroupIds })
        .eq(sessionColumn, userId);

      if (updateSessionError) {
        throw new Error(`Error updating session in ${sessionTable}: ${updateSessionError.message}`);
      }
    } else {
      // Insert new session if not found
      const { error: insertSessionError } = await supabase
        .from(sessionTable)
        .insert([{ [sessionColumn]: userId, group_ids: updatedGroupIds }]);

      if (insertSessionError) {
        throw new Error(`Error inserting session in ${sessionTable}: ${insertSessionError.message}`);
      }
    }

    // ✅ Step 4: Insert or update instances in the _instances table
    const updateInstances = async (instances?: string[]) => {
      if (!instances || instances.length === 0) return;

      // Fetch existing instances
      const { data: existingInstances, error: fetchError } = await supabase
        .from(instanceTable)
        .select("instance_id")
        .in("instance_id", instances);

      if (fetchError) {
        throw new Error(`Error fetching existing instances: ${fetchError.message}`);
      }

      const existingInstanceIds = new Set(existingInstances.map(instance => instance.instance_id));

      // Prepare data for insertion (new instances) or updates (existing instances)
      const newInstances = instances
        .filter(instanceId => !existingInstanceIds.has(instanceId))
        .map(instanceId => ({
          instance_id: instanceId,
          group_id: groupId,
          group_name: groupName,
          [sessionColumn]: userId, // Assign user to instance
        }));

      const updatePromises = instances
        .filter(instanceId => existingInstanceIds.has(instanceId))
        .map(instanceId =>
          supabase
            .from(instanceTable)
            .update({ group_id: groupId, group_name: groupName })
            .eq("instance_id", instanceId)
        );

      // Insert new instances
      if (newInstances.length > 0) {
        const { error: insertError } = await supabase
          .from(instanceTable)
          .insert(newInstances);

        if (insertError) {
          throw new Error(`Error inserting instances: ${insertError.message}`);
        }
      }

      // Update existing instances
      await Promise.all(updatePromises);
    };

    // Handle AWS instances
    if (provider === "aws" || provider === "both") {
      await updateInstances(instanceList.aws);
    }

    // Handle Azure instances
    if (provider === "azure" || provider === "both") {
      await updateInstances(instanceList.azure);
    }

    return `Group '${groupName}' created and instances updated successfully.`;
  } catch (error) {
    console.error("Error in createInstanceGroup:", error);
    if (error instanceof Error) {
      throw new Error(error.message);
    } else {
      throw new Error(String(error));
    }
  }
};


// Function to fetch instance groups
export const getInstanceGroups = async (
  provider: "aws" | "azure",
  instanceIds: string[]
): Promise<Record<string, string>> => {
  try {
    if (instanceIds.length === 0) {
      return {};
    }

    const instanceTable = provider === "aws" ? "aws_instances" : "azure_instances";

    // Query the database to fetch group names for the given instances
    const { data, error } = await supabase
      .from(instanceTable)
      .select("instance_id, group_name")
      .in("instance_id", instanceIds);

    if (error) {
      throw new Error(`Error fetching instance groups: ${error.message}`);
    }

    // Transform the result into a mapping of instanceId -> groupName
    const instanceGroups: Record<string, string> = {};
    data.forEach(({ instance_id, group_name }) => {
      if (group_name) {
        instanceGroups[instance_id] = group_name;
      }
    });

    return instanceGroups;
  } catch (error) {
    console.error("Error in getInstanceGroups:", error);
    return {};
  }
};

export const addInstancesToGroup = async (
  provider: "aws" | "azure" | "both",
  userId: string,
  groupName: string,
  instanceList: { aws?: string[]; azure?: string[] }
): Promise<string> => {
  try {
      // ✅ Step 1: Retrieve the group ID based on the group name
      const { data: groupData, error: groupError } = await supabase
          .from("instance_groups")
          .select("group_id")
          .eq("group_name", groupName)
          .maybeSingle();

      if (groupError) {
          throw new Error(`Error retrieving group ID: ${groupError.message}`);
      }

      if (!groupData) {
          throw new Error(`Group '${groupName}' does not exist.`);
      }

      const groupId = groupData.group_id;

      // ✅ Step 2: Check if the user has access to the group ID
      let userGroupIds: string[] = [];

      if (provider === "both") {
          const { data: awsSession, error: awsError } = await supabase
              .from("aws_sessions")
              .select("group_ids")
              .eq("aws_id", userId)
              .maybeSingle();

          const { data: azureSession, error: azureError } = await supabase
              .from("azure_sessions")
              .select("group_ids")
              .eq("azure_id", userId)
              .maybeSingle();

          if (awsError || azureError) {
              throw new Error(`Error checking user group access: ${awsError?.message || azureError?.message}`);
          }

          userGroupIds = [
              ...(awsSession?.group_ids || []),
              ...(azureSession?.group_ids || [])
          ];
      } else {
          const sessionTable = provider === "aws" ? "aws_sessions" : "azure_sessions";
          const sessionColumn = provider === "aws" ? "aws_id" : "azure_id";

          const { data: sessionData, error: sessionError } = await supabase
              .from(sessionTable)
              .select("group_ids")
              .eq(sessionColumn, userId)
              .maybeSingle();

          if (sessionError) {
              throw new Error(`Error fetching session data from ${sessionTable}: ${sessionError.message}`);
          }

          userGroupIds = sessionData?.group_ids || [];
      }

      if (!userGroupIds.includes(groupId)) {
          throw new Error(`User does not have access to group '${groupName}'.`);
      }

      // ✅ Step 3: Update the instances with the provided group ID
      const updateInstances = async (instances?: string[]) => {
          if (!instances || instances.length === 0) return;

          const instanceTable = provider === "aws" ? "aws_instances" : "azure_instances";

          const { data: existingInstances, error: fetchError } = await supabase
              .from(instanceTable)
              .select("instance_id")
              .in("instance_id", instances);

          if (fetchError) {
              throw new Error(`Error fetching existing instances: ${fetchError.message}`);
          }

          const existingInstanceIds = new Set(existingInstances.map(instance => instance.instance_id));

          // Prepare update statements for existing instances
          const updatePromises = instances
              .filter(instanceId => existingInstanceIds.has(instanceId))
              .map(instanceId =>
                  supabase
                      .from(instanceTable)
                      .update({ group_id: groupId, group_name: groupName })
                      .eq("instance_id", instanceId)
              );

          // Update instances
          await Promise.all(updatePromises);
      };

      // Handle AWS instances
      if (provider === "aws" || provider === "both") {
          await updateInstances(instanceList.aws);
      }

      // Handle Azure instances
      if (provider === "azure" || provider === "both") {
          await updateInstances(instanceList.azure);
      }

      return `✅ Instances successfully added to group "${groupName}".`;
  } catch (error) {
      console.error("❌ Error in addInstancesToGroup:", error);
      throw new Error(error instanceof Error ? error.message : String(error));
  }
};
