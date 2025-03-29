import { AWSManager } from "./awsManager";
import { AzureManager } from "./azureManager";
import { CancellationToken, ExtensionContext, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext, window } from "vscode";
import * as database from "../database/db";

export class CloudManager {
    private static instance: CloudManager;
    private awsManager = new AWSManager();
    private azureManager = new AzureManager();

    private constructor() {} // Prevents external instantiation

    // ✅ Ensure a single instance exists
    public static getInstance(): CloudManager {
        if (!CloudManager.instance) {
            CloudManager.instance = new CloudManager();
        }
        return CloudManager.instance;
    }

    // ✅ Getters for AWSManager and AzureManager
    public getAWSManager() {
        return this.awsManager;
    }

    public getAzureManager() {
        return this.azureManager;
    }

    /**
     * Handles authentication for AWS or Azure.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     * @param credentials User authentication details.
     */
    async connect(provider: "aws" | "azure") {
        if (provider === "aws") {
            const roleArn = await this.promptForInput(
                "AWS Authentication",
                "Enter IAM Role ARN (e.g., arn:aws:iam::USER_AWS_ACCOUNT_ID:role/AllowExternalEC2Management)"
            );
        
            if (!roleArn) {
                window.showErrorMessage("IAM Role ARN is required.");
                return;
            }

            try {
                // Authenticate with AWS and get userAccountId
                const userAccountId: string = await this.awsManager.authenticate(roleArn);
            
                if (!userAccountId || typeof userAccountId !== "string") {
                    throw new Error("Invalid AWS Account ID received after authentication.");
                }
            
                console.log(`✅ AWS Authentication successful for account: ${userAccountId}`);
            
                // Fetch AWS Key Pairs immediately after authentication
                const keyPairs: string[] = (await this.awsManager.fetchKeyPairs(userAccountId)) || [];
            
                console.log(`🔹 Fetched AWS Key Pairs for ${userAccountId}:`, keyPairs);

                const ec2instances = await this.awsManager.fetchAllEC2InstancesAcrossRegions(userAccountId);

                const usergroups = await database.getUserGroups(userAccountId, null);

                console.log('usergroups value: ' + usergroups.awsGroups);

                const cost = await this.awsManager.getTotalMonthlyCost(userAccountId);

                console.log('cost value: ' + cost);
            
                // ✅ Return the userAccountId and keyPairs
                return { userAccountId, keyPairs, ec2instances, usergroups, cost };
            
            } catch (error) {
                console.error(`❌ AWS Authentication or Key Pair retrieval failed:`, error);
                throw new Error(`AWS Authentication failed: ${error}`);
            }
            
        } else if (provider === "azure") {
            const userinfo =  await this.azureManager.authenticate();
            const usergroups = await database.getUserGroups(null, userinfo.userAccountId);

            return {userAccountId: userinfo.userAccountId,
                subscriptions: userinfo.subscriptions,
                resourceGroups: userinfo.resourceGroups,
                cost: userinfo.cost,
                vms: userinfo.vms, usergroups};
        }
        throw new Error("Invalid provider specified.");
    }

    private async promptForInput(title: string, placeholder: string) {
            const inputBox = window.createInputBox();
            inputBox.title = title;
            inputBox.placeholder = placeholder;
            inputBox.ignoreFocusOut = true;
    
            return new Promise<string | null>((resolve) => {
                inputBox.onDidAccept(() => {
                    const value = inputBox.value.trim();
                    inputBox.hide();
                    resolve(value || null);
                });
                inputBox.show();
            });
        }

    /**
     * Creates an instance on AWS or Azure.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     * @param params Instance parameters.
     */
    async createInstance(provider: "aws" | "azure", userId: string, params: { 
        keyPair?: string, 
        subscriptionId?: string, 
        resourceGroup?: string, 
        region?: string, 
        sshKey?: string 
    }) {
        if (provider === "aws") {
            const instanceName = await this.promptForInput(
                "Instance Name",
                "Enter Name for Instance (e.g., my-ec2-instance)"
            );
        
            if (!instanceName) {
                window.showErrorMessage("Instance name is required.");
                return;
            }

            const instanceData = await this.awsManager.createInstance(userId, params, instanceName);
            
            if (!instanceData) {
                throw new Error("Failed to create instance. Instance data is undefined.");
            }
        
            return { 
                instanceId: instanceData.instanceId, 
                instanceName: instanceData.instanceName 
            };
        } else if (provider === "azure") {
            if (!params.subscriptionId || !params.resourceGroup || !params.region || !params.sshKey) {
                throw new Error("❌ Missing required parameters for Azure VM creation.");
            }

            const vmName = await this.promptForInput(
                "VM Name",
                "Enter Name for VM (e.g., my-azure-vm)"
            );
        
            if (!vmName) {
                window.showErrorMessage("IAM Role ARN is required.");
                return;
            }
    
            console.log(`📤 Creating Azure VM for userId: ${userId} in region: ${params.region}, Subscription: ${params.subscriptionId}, Resource Group: ${params.resourceGroup}`);
    
            try {
                const vmId = await this.azureManager.createInstance({
                    subscriptionId: params.subscriptionId,
                    resourceGroup: params.resourceGroup,
                    region: params.region,
                    userId,
                    sshKey: params.sshKey,
                    vmName
                });
    
                console.log(`✅ Azure VM created successfully. VM ID: ${vmId}`);
                return {vmId, vmName};
    
            } catch (error) {
                console.error("❌ Error creating Azure VM:", error);
                throw new Error(`Azure VM creation failed: ${error}`);
            }
        }
        throw new Error("Invalid provider specified.");
    }    

    /**
     * Assigns an instance to a group for batch shutdowns.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     * @param instanceId ID of the instance.
     * @param groupId ID of the group.
     */
    async assignInstanceToGroup(provider: "aws" | "azure", userId: string, instanceId: string, groupId: string) {
        return { message: `Instance ${instanceId} added to group ${groupId}` };
    }

    async changeRegion(provider: "aws" | "azure", userId: string, region: string): Promise<string[]> {
        if (provider === "aws") {
            console.log(`🔹 Changing AWS region for user ${userId} to: ${region}`);
    
            // ✅ Ensure a valid session exists before proceeding
            const keyPairs = await this.awsManager.changeRegion(userId, region);
            if (keyPairs.length === 0) {
                console.warn(`⚠️ No key pairs found after region change.`);
            }
    
            return keyPairs; // ✅ Return updated key pairs to be sent to the UI
        } 
    
        console.error(`❌ Invalid provider specified: ${provider}`);
        throw new Error("Invalid provider specified.");
    }    

    async getResourceGroupsForSubscription(provider: "azure", userId: string, subscriptionId: string) {
        return await this.azureManager.getResourceGroupsForSubscription(provider, userId, subscriptionId);
    }

        /**
     * Shuts down multiple AWS instances.
     * @param userIdAWS The AWS user ID.
     * @param instanceIds An array of instance IDs to be shut down.
     */
    async shutdownInstances(userIdAWS: string, instanceIds: string[]) {
        if (!userIdAWS) {
            console.error("❌ No AWS user ID provided.");
            throw new Error("AWS user ID is required to shut down instances.");
        }

        if (!instanceIds || instanceIds.length === 0) {
            console.error("❌ No instance IDs provided.");
            throw new Error("At least one instance ID is required to shut down instances.");
        }

        console.log(`📤 Shutting down instances for AWS user ${userIdAWS}:`, instanceIds);

        try {
            // ✅ Call AWS Manager function (to be implemented in AWSManager.ts)
            await this.awsManager.shutdownInstances(userIdAWS, instanceIds);
            console.log(`✅ Successfully initiated shutdown for instances: ${instanceIds.join(", ")}`);
        } catch (error) {
            console.error(`❌ Failed to shut down instances: ${error}`);
            throw new Error(`Instance shutdown failed: ${error}`);
        }
    }

    async stopVMs(userIdAzure: string, vms: { vmId: string; subscriptionId: string }[]) {
        if (!userIdAzure) {
            console.error("❌ No Azure user ID provided.");
            throw new Error("Azure user ID is required to stop VMs.");
        }
    
        if (!vms || vms.length === 0) {
            console.error("❌ No VM IDs provided.");
            throw new Error("At least one VM ID with a subscription ID is required to stop VMs.");
        }
    
        console.log(`📤 Stopping VMs for Azure user ${userIdAzure}:`, vms);
    
        try {
            for (const { vmId, subscriptionId } of vms) {
                console.log(`🛑 Stopping VM: ${vmId} in Subscription: ${subscriptionId}`);
                await this.azureManager.stopVMs(userIdAzure, [{ vmId, subscriptionId }]);
            }
            
            console.log(`✅ Successfully initiated shutdown for VMs:`, vms);
        } catch (error) {
            console.error(`❌ Failed to stop VMs: ${error}`);
            throw new Error(`VM shutdown failed: ${error}`);
        }
    }     

    async refreshAWSInstances(userIdAWS: string) {
        console.log(`🔄 Fetching latest AWS instances for user ${userIdAWS}`);
    
        if (!userIdAWS) {
            console.error("❌ No AWS user ID provided.");
            throw new Error("AWS user ID is required to refresh instances.");
        }
    
        try {
            // ✅ Call AWS Manager function to fetch instances (we assume it exists)
            const instances = await this.awsManager.fetchAllEC2InstancesAcrossRegions(userIdAWS);
    
            console.log(`✅ Retrieved ${instances.length} updated AWS instances`);
            return instances;
    
        } catch (error) {
            console.error(`❌ Error retrieving AWS instances for user ${userIdAWS}:`, error);
            throw new Error(`Failed to refresh AWS instances: ${error}`);
        }
    }

    async refreshAzureInstances(userIdAzure: string) {
        console.log(`🔄 Fetching latest Azure VMs for user ${userIdAzure}`);
    
        if (!userIdAzure) {
            console.error("❌ No Azure user ID provided.");
            throw new Error("Azure user ID is required to refresh VMs.");
        }
    
        try {
            // ✅ Call Azure Manager function to fetch instances
            const vms = await this.azureManager.getUserVMs(userIdAzure);
    
            console.log(`✅ Retrieved ${vms.length} updated Azure VMs`);
            return vms;
    
        } catch (error) {
            console.error(`❌ Error retrieving Azure VMs for user ${userIdAzure}:`, error);
            throw new Error(`Failed to refresh Azure VMs: ${error}`);
        }
    }    

    async terminateAWSInstances(userIdAWS: string, instanceIds: string[]) {
        console.log(`🗑️ Requesting termination of AWS instances for user ${userIdAWS}`);
    
        if (!userIdAWS) {
            console.error("❌ No AWS user ID provided.");
            throw new Error("AWS user ID is required to terminate instances.");
        }
    
        try {
            // ✅ Call AWS Manager function to terminate instances
            await this.awsManager.terminateInstances(userIdAWS, instanceIds);
    
            console.log(`✅ Successfully terminated AWS instances: ${instanceIds.join(", ")}`);
            return instanceIds;
    
        } catch (error) {
            console.error(`❌ Error terminating AWS instances for user ${userIdAWS}:`, error);
            throw new Error(`Failed to terminate AWS instances: ${error}`);
        }
    }    

    async deleteVMs(userIdAzure: string, vms: { vmId: string; subscriptionId: string }[]) {
        if (!userIdAzure) {
            console.error("❌ No Azure user ID provided.");
            throw new Error("Azure user ID is required to delete VMs.");
        }
    
        if (!vms || vms.length === 0) {
            console.error("❌ No VM IDs provided.");
            throw new Error("At least one VM ID with a subscription ID is required to delete VMs.");
        }
    
        console.log(`📤 Deleting VMs for Azure user ${userIdAzure}:`, vms);
    
        try {
            for (const { vmId, subscriptionId } of vms) {
                console.log(`🗑️ Deleting VM: ${vmId} in Subscription: ${subscriptionId}`);
                await this.azureManager.deleteVMs(userIdAzure, [{ vmId, subscriptionId }]);
            }
            
            console.log(`✅ Successfully initiated deletion for VMs:`, vms);
        } catch (error) {
            console.error(`❌ Failed to delete VMs: ${error}`);
            throw new Error(`VM deletion failed: ${error}`);
        }
    }    

    async startAWSInstances(userIdAWS: string, instanceIds: string[]) {
        console.log(`🚀 Requesting start of AWS instances for user ${userIdAWS}`);
    
        if (!userIdAWS) {
            console.error("❌ No AWS user ID provided.");
            throw new Error("AWS user ID is required to start instances.");
        }
    
        if (!instanceIds || instanceIds.length === 0) {
            console.error("❌ No instance IDs provided.");
            throw new Error("At least one instance ID is required to start instances.");
        }
    
        try {
            // ✅ Call AWS Manager function to start instances
            await this.awsManager.startInstances(userIdAWS, instanceIds);
    
            console.log(`✅ Successfully started AWS instances: ${instanceIds.join(", ")}`);
            return instanceIds;
    
        } catch (error) {
            console.error(`❌ Error starting AWS instances for user ${userIdAWS}:`, error);
            throw new Error(`Failed to start AWS instances: ${error}`);
        }
    }    
    async startVMs(userIdAzure: string, vms: { vmId: string; subscriptionId: string }[]) {
        if (!userIdAzure) {
            console.error("❌ No Azure user ID provided.");
            throw new Error("Azure user ID is required to start VMs.");
        }
    
        if (!vms || vms.length === 0) {
            console.error("❌ No VM IDs provided.");
            throw new Error("At least one VM ID with a subscription ID is required to start VMs.");
        }
    
        console.log(`📤 Starting VMs for Azure user ${userIdAzure}:`, vms);
    
        try {
            for (const { vmId, subscriptionId } of vms) {
                console.log(`🚀 Starting VM: ${vmId} in Subscription: ${subscriptionId}`);
                await this.azureManager.startVMs(userIdAzure, [{ vmId, subscriptionId }]);
            }
            
            console.log(`✅ Successfully initiated start for VMs:`, vms);
        } catch (error) {
            console.error(`❌ Failed to start VMs: ${error}`);
            throw new Error(`VM start failed: ${error}`);
        }
    }    
    async createGroup(
        provider: "aws" | "azure" | "both",
        userIds: { aws?: string; azure?: string },
        instanceLists: { aws?: string[]; azure?: string[] },
        subscriptionIds?: string[]
      ) {
        try {
          const groupName = await this.promptForInput("Enter Group Name", "Group name...");
          if (!groupName) {
            window.showErrorMessage("❌ Group creation canceled: No name provided.");
            return;
          }
      
          console.log(`📩 Creating ${provider.toUpperCase()} group "${groupName}" for users:`, userIds);
      
          // ✅ Call the shared DB helper function
          await database.createInstanceGroup(
            provider,
            userIds,
            groupName,
            instanceLists,
            subscriptionIds || []
          );
      
          window.showInformationMessage(`✅ Group "${groupName}" created successfully.`);
          return groupName;
      
        } catch (error) {
          console.error("❌ Error creating group:", error);
          window.showErrorMessage(`❌ Error creating group: ${error}`);
          return null;
        }
      }
           
      async addInstancesToGroup(
        provider: "aws" | "azure" | "both",
        userId: string | { aws: string; azure: string },
        instanceIds: string[] | { aws: string[]; azure: string[] },
        subscriptionIds?: string[]
        ): Promise<string | null> {
        try {
            const groupName = await this.promptForInput("Enter Group Name", "Group name...");
            if (!groupName) {
            window.showErrorMessage("❌ Adding instances canceled: No group name provided.");
            return null;
            }

            let instanceList: { aws?: string[]; azure?: string[] } = {};
            let userAws: string = "";
            let userAzure: string = "";

            if (provider === "both") {
            const ids = instanceIds as { aws: string[]; azure: string[] };
            instanceList = { aws: ids.aws, azure: ids.azure };
            const users = userId as { aws: string; azure: string };
            userAws = users.aws;
            userAzure = users.azure;

            await database.addInstancesToGroup("both", { aws: userAws, azure: userAzure }, groupName, instanceList, subscriptionIds || []);
            } else {
            const ids = instanceIds as string[];
            const uid = userId as string;
            instanceList = provider === "aws" ? { aws: ids } : { azure: ids };
            await database.addInstancesToGroup(provider, uid, groupName, instanceList, subscriptionIds || []);
            }

            window.showInformationMessage(`✅ Successfully added instance(s) to group "${groupName}".`);
            return groupName;
        } catch (error) {
            window.showErrorMessage(`❌ Error adding instances: ${error}`);
            return null;
        }
        }    
    async removeInstancesFromGroup(
        provider: "aws" | "azure" | "both",
        userId: string | { aws: string; azure: string },
        instanceIds: string[] | { aws: string[]; azure: string[] }
        ) {
        try {
            // ✅ Format the instance list properly for the database layer
            const instanceList =
            provider === "both"
                ? (instanceIds as { aws: string[]; azure: string[] })
                : {
                    aws: provider === "aws" ? (instanceIds as string[]) : undefined,
                    azure: provider === "azure" ? (instanceIds as string[]) : undefined
                };

            const userIdMap =
            provider === "both"
                ? (userId as { aws: string; azure: string })
                : userId;

            // ✅ Call the database function
            const result = await database.removeInstancesFromGroup(provider, userIdMap, instanceList);

            // ✅ Feedback
            window.showInformationMessage(`✅ Successfully removed instance(s) from group.`);
            console.log(result);
            return "N/A";
        } catch (error) {
            window.showErrorMessage(`❌ Error removing instances: ${error}`);
            console.error("❌ Error removing instances from group:", error);
            return null;
        }
        }

    async setGroupDowntime(provider: "aws" | "azure" | "both", userId: string, groupName: string) {
        try {
            // ✅ Prompt user for start time
            const startTime = await this.promptForInput("Enter Start Time", "YYYY-MM-DD HH:MM");
            if (!startTime) {
                window.showErrorMessage("❌ Downtime setting canceled: No start time provided.");
                return;
            }
    
            // ✅ Prompt user for end time
            const endTime = await this.promptForInput("Enter End Time", "YYYY-MM-DD HH:MM");
            if (!endTime) {
                window.showErrorMessage("❌ Downtime setting canceled: No end time provided.");
                return;
            }
    
            // ✅ Validate time format
            const startDate = new Date(startTime);
            const endDate = new Date(endTime);
    
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                window.showErrorMessage("❌ Invalid date format. Please enter a valid datetime in 'YYYY-MM-DD HH:MM' format.");
                return;
            }
    
            if (endDate <= startDate) {
                window.showErrorMessage("❌ End time must be after start time.");
                return;
            }
    
            console.log(`📩 Setting downtime for ${provider.toUpperCase()} group: "${groupName}" from ${startTime} to ${endTime}.`);
    
            // ✅ Call the database function to update downtime
            const result = await database.updateGroupDowntime(groupName, startTime, endTime);
    
            // ✅ Provide feedback to the user
            window.showInformationMessage(`✅ Downtime set for group "${groupName}" from ${startTime} to ${endTime}.`);
            console.log(result);

            return { startTime, endTime };
    
        } catch (error) {
            console.error("❌ Error setting downtime:", error);
            window.showErrorMessage(`❌ Error setting downtime: ${error}`);
        }
    }
    async removeGroupDowntime(groupName: string): Promise<boolean> {
        try {
            console.log(`📤 Removing downtime for group: '${groupName}'`);
    
            // ✅ Call the database function to remove downtime for the given group
            const success = await database.removeGroupDowntime(groupName);
    
            if (success) {
                console.log(`✅ Successfully removed downtime for group '${groupName}'.`);
            } else {
                console.warn(`⚠️ No downtime found for group '${groupName}', or deletion failed.`);
            }
    
            return success;
        } catch (error) {
            console.error("❌ Error in removeGroupDowntime:", error);
            return false;
        }
    } 
    async getMultiCloudGroupNames(
        awsId: string,
        azureId: string
      ): Promise<string[]> {
        try {
          const groupNames = await database.getMultiUserGroups(awsId, azureId);
          return groupNames;
        } catch (error) {
          console.error("❌ Error fetching multi-cloud group names:", error);
          return [];
        }
    } 
    
    async getMonthlyCostUnified(provider: "aws" | "azure", userId: string): Promise<string> {
        try {
            if (provider === "aws") {
                return await this.awsManager.getTotalMonthlyCost(userId);
            } else if (provider === "azure") {
                return await this.azureManager.getMonthlyCost(userId);
            } else {
                throw new Error(`Unsupported provider: ${provider}`);
            }
        } catch (error) {
            console.error(`❌ Error fetching monthly cost for ${provider.toUpperCase()}:`, error);
            return "0.00"; // Default to 0 if error occurs
        }
    }
    
}


