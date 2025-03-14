import { AWSManager } from "./awsManager";
import { AzureManager } from "./azureManager";
import { CancellationToken, ExtensionContext, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext, window } from "vscode";
import * as database from "../database/db";

export class CloudManager {
    private awsManager = new AWSManager();
    private azureManager = new AzureManager();

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

                const ec2instances = await this.awsManager.fetchAllEC2InstancesAcrossRegions(userAccountId)
            
                // ✅ Return the userAccountId and keyPairs
                return { userAccountId, keyPairs, ec2instances };
            
            } catch (error) {
                console.error(`❌ AWS Authentication or Key Pair retrieval failed:`, error);
                throw new Error(`AWS Authentication failed: ${error}`);
            }
            
        } else if (provider === "azure") {
            return await this.azureManager.authenticate();
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
            return await this.awsManager.createInstance(userId, params);
        } else if (provider === "azure") {
            if (!params.subscriptionId || !params.resourceGroup || !params.region || !params.sshKey) {
                throw new Error("❌ Missing required parameters for Azure VM creation.");
            }
    
            console.log(`📤 Creating Azure VM for userId: ${userId} in region: ${params.region}, Subscription: ${params.subscriptionId}, Resource Group: ${params.resourceGroup}`);
    
            try {
                const vmId = await this.azureManager.createInstance({
                    subscriptionId: params.subscriptionId,
                    resourceGroup: params.resourceGroup,
                    region: params.region,
                    userId,
                    sshKey: params.sshKey
                });
    
                console.log(`✅ Azure VM created successfully. VM ID: ${vmId}`);
                return vmId;
    
            } catch (error) {
                console.error("❌ Error creating Azure VM:", error);
                throw new Error(`Azure VM creation failed: ${error}`);
            }
        }
        throw new Error("Invalid provider specified.");
    }    

    /**
     * Stops an instance on AWS or Azure.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     * @param instanceId The ID of the instance to be stopped.
     */
    async stopInstance(provider: "aws" | "azure", userId: string, instanceId: string) {
        if (provider === "aws") {
            return await this.awsManager.stopInstance(userId, instanceId);
        } else if (provider === "azure") {
            return await this.azureManager.stopInstance(userId, instanceId);
        }
        throw new Error("Invalid provider specified.");
    }

    /**
     * Fetches instances associated with a user from AWS or Azure.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     */
    async fetchInstances(provider: "aws" | "azure", userId: string) {
        return "hello";
    }

    /**
     * Fetches all instance groups for AWS or Azure.
     * @param provider "aws" | "azure"
     */
    async fetchGroups(provider: "aws" | "azure") {
        return "hello";
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
    
}
