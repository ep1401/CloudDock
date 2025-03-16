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

      // ✅ Step 3: Insert instances if they do not exist or update if they do
      const upsertInstances = async (instances?: string[], instanceTable?: string, sessionColumn?: string) => {
          if (!instances || instances.length === 0 || !instanceTable || !sessionColumn) return;

          const instanceData = instances.map(instanceId => ({
              instance_id: instanceId,
              group_id: groupId,
              group_name: groupName,
              [sessionColumn]: userId
          }));

          const { error: upsertError } = await supabase
              .from(instanceTable)
              .upsert(instanceData, { onConflict: "instance_id" });

          if (upsertError) {
              throw new Error(`Error inserting/updating instances: ${upsertError.message}`);
          }
      };

      // Handle AWS instances
      if (provider === "aws" || provider === "both") {
          await upsertInstances(instanceList.aws, "aws_instances", "aws_id");
      }

      // Handle Azure instances
      if (provider === "azure" || provider === "both") {
          await upsertInstances(instanceList.azure, "azure_instances", "azure_id");
      }

      return `✅ Instances successfully added to group "${groupName}".`;
  } catch (error) {
      console.error("❌ Error in addInstancesToGroup:", error);
      throw new Error(error instanceof Error ? error.message : String(error));
  }
};

export const removeInstancesFromGroup = async (
  provider: "aws" | "azure" | "both",
  userId: string,
  instanceList: { aws?: string[]; azure?: string[] }
): Promise<string> => {
  try {
      // ✅ Function to delete instances from the instance table
      const deleteInstances = async (instances?: string[], instanceTable?: string) => {
          if (!instances || instances.length === 0 || !instanceTable) return;

          const { error: deleteError } = await supabase
              .from(instanceTable)
              .delete()
              .in("instance_id", instances);

          if (deleteError) {
              throw new Error(`Error removing instances from group: ${deleteError.message}`);
          }
      };

      // ✅ Handle AWS instances
      if (provider === "aws" || provider === "both") {
          await deleteInstances(instanceList.aws, "aws_instances");
      }

      // ✅ Handle Azure instances
      if (provider === "azure" || provider === "both") {
          await deleteInstances(instanceList.azure, "azure_instances");
      }

      return `✅ Instances successfully removed from group.`;
  } catch (error) {
      console.error("❌ Error in removeInstancesFromGroup:", error);
      throw new Error(error instanceof Error ? error.message : String(error));
  }
};

export const getUserGroups = async (
  awsId: string | null,
  azureId: string | null
): Promise<{ awsGroups: string[]; azureGroups: string[] }> => {
  try {
      let awsGroups: string[] = [];
      let azureGroups: string[] = [];

      // ✅ Fetch AWS group names if awsId is provided
      if (awsId) {
          const { data: awsData, error: awsError } = await supabase
              .from("aws_sessions")
              .select("group_ids")
              .eq("aws_id", awsId)
              .maybeSingle();

          if (awsError) {
              throw new Error(`Error fetching AWS groups: ${awsError.message}`);
          }

          if (awsData?.group_ids?.length) {
              const { data: groupNames, error: groupError } = await supabase
                  .from("instance_groups")
                  .select("group_name")
                  .in("group_id", awsData.group_ids);

              if (groupError) {
                  throw new Error(`Error retrieving AWS group names: ${groupError.message}`);
              }

              awsGroups = groupNames.map(g => g.group_name);
          }
      }

      // ✅ Fetch Azure group names if azureId is provided
      if (azureId) {
          const { data: azureData, error: azureError } = await supabase
              .from("azure_sessions")
              .select("group_ids")
              .eq("azure_id", azureId)
              .maybeSingle();

          if (azureError) {
              throw new Error(`Error fetching Azure groups: ${azureError.message}`);
          }

          if (azureData?.group_ids?.length) {
              const { data: groupNames, error: groupError } = await supabase
                  .from("instance_groups")
                  .select("group_name")
                  .in("group_id", azureData.group_ids);

              if (groupError) {
                  throw new Error(`Error retrieving Azure group names: ${groupError.message}`);
              }

              azureGroups = groupNames.map(g => g.group_name);
          }
      }

      return { awsGroups, azureGroups };
  } catch (error) {
      console.error("❌ Error in getUserGroups:", error);
      throw new Error(error instanceof Error ? error.message : String(error));
  }
};

export const updateGroupDowntime = async (
  groupName: string,
  startTime: string,
  endTime: string
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

      // ✅ Step 2: Update or insert the group downtime
      const { error: upsertError } = await supabase
          .from("group_downtime")
          .upsert(
              [{
                  group_id: groupId,
                  start_time: startTime,
                  end_time: endTime
              }],
              { onConflict: "group_id" } // Ensures existing downtime is updated
          );

      if (upsertError) {
          throw new Error(`Error updating group downtime: ${upsertError.message}`);
      }

      return `✅ Downtime for group '${groupName}' successfully updated.`;
  } catch (error) {
      console.error("❌ Error in updateGroupDowntime:", error);
      throw new Error(error instanceof Error ? error.message : String(error));
  }
};

export const getGroupDowntime = async (groupName: string) => {
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
          console.warn(`⚠️ No group found with name '${groupName}'.`);
          return { startTime: "N/A", endTime: "N/A" };
      }

      const groupId = groupData.group_id;

      // ✅ Step 2: Query the group_downtime table using the retrieved group ID
      const { data: downtimeData, error: downtimeError } = await supabase
          .from("group_downtime")
          .select("start_time, end_time")
          .eq("group_id", groupId)
          .maybeSingle();

      if (downtimeError) {
          throw new Error(`Error retrieving downtime: ${downtimeError.message}`);
      }

      if (!downtimeData) {
          console.warn(`⚠️ No scheduled downtime found for group '${groupName}'.`);
          return { startTime: "N/A", endTime: "N/A" };
      }

      // ✅ Step 3: Return the retrieved downtime
      return {
          startTime: downtimeData.start_time ?? "N/A",
          endTime: downtimeData.end_time ?? "N/A"
      };
  } catch (error) {
      console.error("❌ Error retrieving group downtime:", error);
      return { startTime: "N/A", endTime: "N/A" }; // Return "N/A" on error
  }
};

export const removeGroupDowntime = async (groupName: string): Promise<boolean> => {
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
          console.warn(`⚠️ No group found with name '${groupName}'.`);
          return false;
      }

      const groupId = groupData.group_id;

      // ✅ Step 2: Delete the row from the group_downtime table
      const { error: deleteError } = await supabase
          .from("group_downtime")
          .delete()
          .eq("group_id", groupId);

      if (deleteError) {
          throw new Error(`Error deleting downtime: ${deleteError.message}`);
      }

      console.log(`✅ Successfully removed downtime for group '${groupName}'.`);
      return true; // Successfully deleted

  } catch (error) {
      console.error("❌ Error removing group downtime:", error);
      return false; // Return false if an error occurred
  }
};

export const getAllGroupDowntimes = async () => {
  try {
      // ✅ Step 1: Define the expected type structure
      type GroupDowntime = {
          group_id: string;
          start_time: string;
          end_time: string;
          instance_groups: { group_name: string } | null;
      };

      // ✅ Step 2: Retrieve all group downtimes with their group names
      const { data, error } = await supabase
          .from("group_downtime")
          .select("group_id, start_time, end_time, instance_groups (group_name)")
          .returns<GroupDowntime[]>(); // Explicit return type

      // ✅ Step 3: Handle errors
      if (error) {
          throw new Error(`Error retrieving group downtimes: ${error.message}`);
      }

      // ✅ Step 4: If no data found, return an empty array
      if (!data || data.length === 0) {
          console.warn("⚠️ No group downtimes found.");
          return [];
      }

      // ✅ Step 5: Ensure correct extraction of `group_name`
      return data.map(downtime => ({
          groupName: downtime.instance_groups?.group_name || "Unknown",
          startTime: downtime.start_time,
          endTime: downtime.end_time
      }));

  } catch (error) {
      console.error("❌ Error retrieving all group downtimes:", error);
      return []; // Return empty array if an error occurs
  }
};

export const getInstancesByGroup = async (groupName: string) => {
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
          console.warn(`⚠️ No group found with name '${groupName}'.`);
          return { awsInstances: [], azureInstances: [] };
      }

      const groupId = groupData.group_id;

      // ✅ Step 2: Retrieve AWS instances associated with the group ID
      const { data: awsInstances, error: awsError } = await supabase
          .from("aws_instances")
          .select("instance_id, aws_id")
          .eq("group_id", groupId);

      if (awsError) {
          throw new Error(`Error retrieving AWS instances: ${awsError.message}`);
      }

      // ✅ Step 3: Retrieve Azure instances associated with the group ID
      const { data: azureInstances, error: azureError } = await supabase
          .from("azure_instances")
          .select("instance_id, azure_id")
          .eq("group_id", groupId);

      if (azureError) {
          throw new Error(`Error retrieving Azure instances: ${azureError.message}`);
      }

      console.log(`✅ Retrieved ${awsInstances.length} AWS instances and ${azureInstances.length} Azure instances for group '${groupName}'.`);
      return { awsInstances: awsInstances || [], azureInstances: azureInstances || [] };

  } catch (error) {
      console.error("❌ Error retrieving instances by group:", error);
      return { awsInstances: [], azureInstances: [] }; // Return empty lists on error
  }
};


