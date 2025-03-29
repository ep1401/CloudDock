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
  userIds: { aws?: string; azure?: string },
  groupName: string,
  instanceList: { aws?: string[]; azure?: string[] },
  subscriptionIds?: string[]
): Promise<string> => {
  try {
    // ✅ Check group name uniqueness
    const { data: existingGroup, error: groupError } = await supabase
      .from("instance_groups")
      .select("group_id")
      .eq("group_name", groupName)
      .maybeSingle();

    if (groupError) throw new Error(`Error checking group name: ${groupError.message}`);
    if (existingGroup) throw new Error(`A group with the name '${groupName}' already exists.`);

    // ✅ Create group
    const groupId = uuidv4();
    const { error: insertGroupError } = await supabase
      .from("instance_groups")
      .insert([{ group_id: groupId, group_name: groupName }]);
    if (insertGroupError) throw new Error(`Error creating group: ${insertGroupError.message}`);

    // ✅ Add group ID to each session and update/insert instances
    const updateSessionsAndInstances = async (
      cloud: "aws" | "azure",
      ids: string[],
      subs?: string[]
    ) => {
      const sessionTable = cloud === "aws" ? "aws_sessions" : "azure_sessions";
      const instanceTable = cloud === "aws" ? "aws_instances" : "azure_instances";
      const idColumn = cloud === "aws" ? "aws_id" : "azure_id";
      const userId = userIds[cloud];

      if (!userId || ids.length === 0) return;

      // ✅ Update session with new group_id
      const { data: sessionData, error: sessionErr } = await supabase
        .from(sessionTable)
        .select("group_ids")
        .eq(idColumn, userId)
        .maybeSingle();

      if (sessionErr) throw new Error(`Error reading session for ${cloud}: ${sessionErr.message}`);

      const updatedGroups = sessionData
        ? [...new Set([...sessionData.group_ids, groupId])]
        : [groupId];

      if (sessionData) {
        await supabase
          .from(sessionTable)
          .update({ group_ids: updatedGroups })
          .eq(idColumn, userId);
      } else {
        await supabase
          .from(sessionTable)
          .insert([{ [idColumn]: userId, group_ids: updatedGroups }]);
      }

      // ✅ Handle instance updates/inserts
      const { data: existing, error: fetchErr } = await supabase
        .from(instanceTable)
        .select("instance_id")
        .in("instance_id", ids);

      if (fetchErr) throw new Error(`Error fetching ${cloud} instances: ${fetchErr.message}`);

      const existingIds = new Set(existing.map(inst => inst.instance_id));

      const newEntries = ids
        .filter(id => !existingIds.has(id))
        .map((id, index) => {
          const base: any = {
            instance_id: id,
            group_id: groupId,
            group_name: groupName,
            [idColumn]: userId
          };
          if (cloud === "azure" && subs?.[index]) {
            base.sub_name = subs[index];
          }
          return base;
        });

      const updatePromises = ids
        .filter(id => existingIds.has(id))
        .map((id, index) => {
          const update: any = { group_id: groupId, group_name: groupName };
          if (cloud === "azure" && subs?.[index]) {
            update.sub_name = subs[index];
          }
          return supabase.from(instanceTable).update(update).eq("instance_id", id);
        });

      if (newEntries.length > 0) {
        await supabase.from(instanceTable).insert(newEntries);
      }

      await Promise.all(updatePromises);
    };

    // ✅ Apply updates by provider
    if (provider === "aws" || provider === "both") {
      await updateSessionsAndInstances("aws", instanceList.aws || []);
    }

    if (provider === "azure" || provider === "both") {
      await updateSessionsAndInstances("azure", instanceList.azure || [], subscriptionIds);
    }

    return groupName;
  } catch (error) {
    console.error("Error in createInstanceGroup:", error);
    throw new Error(error instanceof Error ? error.message : String(error));
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
  userId: string | { aws: string; azure: string },
  groupName: string,
  instanceList: { aws?: string[]; azure?: string[] },
  subscriptionIds?: string[]
): Promise<string> => {
  try {
    // ✅ Step 1: Get group ID
    const { data: groupData, error: groupError } = await supabase
      .from("instance_groups")
      .select("group_id")
      .eq("group_name", groupName)
      .maybeSingle();

    if (groupError) throw new Error(`Error retrieving group ID: ${groupError.message}`);
    if (!groupData) throw new Error(`Group '${groupName}' does not exist.`);

    const groupId = groupData.group_id;

    // ✅ Step 2: Verify user has access to the group
    let userGroupIds: string[] = [];

    if (provider === "both") {
      const { aws: awsUserId, azure: azureUserId } = userId as { aws: string; azure: string };

      const { data: awsSession, error: awsError } = await supabase
        .from("aws_sessions")
        .select("group_ids")
        .eq("aws_id", awsUserId)
        .maybeSingle();

      const { data: azureSession, error: azureError } = await supabase
        .from("azure_sessions")
        .select("group_ids")
        .eq("azure_id", azureUserId)
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
        .eq(sessionColumn, userId as string)
        .maybeSingle();

      if (sessionError) {
        throw new Error(`Error fetching session data from ${sessionTable}: ${sessionError.message}`);
      }

      userGroupIds = sessionData?.group_ids || [];
    }

    if (!userGroupIds.includes(groupId)) {
      throw new Error(`User does not have access to group '${groupName}'.`);
    }

    // ✅ Step 3: Upsert instances
    const upsertInstances = async (
      instances?: string[],
      instanceTable?: string,
      sessionColumn?: string,
      subs?: string[],
      userKey?: string
    ) => {
      if (!instances || instances.length === 0 || !instanceTable || !sessionColumn || !userKey) return;

      const instanceData = instances.map((instanceId, index) => {
        const base = {
          instance_id: instanceId,
          group_id: groupId,
          group_name: groupName,
          [sessionColumn]: userKey
        };

        if (instanceTable === "azure_instances" && subs?.[index]) {
          return { ...base, sub_name: subs[index] };
        }

        return base;
      });

      const { error: upsertError } = await supabase
        .from(instanceTable)
        .upsert(instanceData, { onConflict: "instance_id" });

      if (upsertError) {
        throw new Error(`Error inserting/updating instances: ${upsertError.message}`);
      }
    };

    // ✅ Handle AWS
    if (provider === "aws" || provider === "both") {
      const awsId = provider === "both" ? (userId as { aws: string }).aws : (userId as string);
      await upsertInstances(instanceList.aws, "aws_instances", "aws_id", undefined, awsId);
    }

    // ✅ Handle Azure
    if (provider === "azure" || provider === "both") {
      const azureId = provider === "both" ? (userId as { azure: string }).azure : (userId as string);
      await upsertInstances(instanceList.azure, "azure_instances", "azure_id", subscriptionIds, azureId);
    }

    return `✅ Instances successfully added to group "${groupName}".`;
  } catch (error) {
    console.error("❌ Error in addInstancesToGroup:", error);
    throw new Error(error instanceof Error ? error.message : String(error));
  }
};

export const removeInstancesFromGroup = async (
  provider: "aws" | "azure" | "both",
  userId: string | { aws: string; azure: string },
  instanceList: { aws?: string[]; azure?: string[] }
): Promise<string> => {
  try {
    // ✅ Helper function to delete instances and validate ownership
    const deleteInstances = async (
      instances?: string[],
      instanceTable?: string,
      userKey?: string,
      userValue?: string
    ) => {
      if (!instances || instances.length === 0 || !instanceTable || !userKey || !userValue) return;

      const { error: deleteError } = await supabase
        .from(instanceTable)
        .delete()
        .in("instance_id", instances)
        .eq(userKey, userValue); // Make sure we only delete for the correct user

      if (deleteError) {
        throw new Error(`Error removing instances from ${instanceTable}: ${deleteError.message}`);
      }
    };

    // ✅ AWS removal
    if (provider === "aws" || provider === "both") {
      const awsUserId = provider === "both" ? (userId as { aws: string }).aws : (userId as string);
      await deleteInstances(instanceList.aws, "aws_instances", "aws_id", awsUserId);
    }

    // ✅ Azure removal
    if (provider === "azure" || provider === "both") {
      const azureUserId = provider === "both" ? (userId as { azure: string }).azure : (userId as string);
      await deleteInstances(instanceList.azure, "azure_instances", "azure_id", azureUserId);
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

    // ✅ Step 2: Retrieve AWS instances
    const { data: awsInstances, error: awsError } = await supabase
      .from("aws_instances")
      .select("instance_id, aws_id")
      .eq("group_id", groupId);

    if (awsError) {
      throw new Error(`Error retrieving AWS instances: ${awsError.message}`);
    }

    // ✅ Step 3: Retrieve Azure instances (with subscription ID)
    const { data: azureInstances, error: azureError } = await supabase
      .from("azure_instances")
      .select("instance_id, azure_id, sub_name") // ← added sub_name here
      .eq("group_id", groupId);

    if (azureError) {
      throw new Error(`Error retrieving Azure instances: ${azureError.message}`);
    }

    console.log(`✅ Retrieved ${awsInstances.length} AWS instances and ${azureInstances.length} Azure instances for group '${groupName}'.`);

    return {
      awsInstances: awsInstances || [],
      azureInstances: azureInstances || []
    };

  } catch (error) {
    console.error("❌ Error retrieving instances by group:", error);
    return { awsInstances: [], azureInstances: [] };
  }
};


