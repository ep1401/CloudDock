import * as vscode from "vscode";
import { DefaultAzureCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { ResourceManagementClient } from "@azure/arm-resources";
import { NetworkManagementClient } from "@azure/arm-network";
import { SubscriptionClient } from "@azure/arm-subscriptions";

export class AzureManager {
    // ✅ Store both subscriptions and resource groups
    private userSessions: Map<string, { 
        azureCredential: DefaultAzureCredential; 
        subscriptions: { subscriptionId: string; displayName: string }[]; 
    }> = new Map();

    getUserSession(userAccountId: string) {
        return this.userSessions.get(userAccountId);
    }

    updateUserSession(
        userAccountId: string, 
        session: { 
            azureCredential: DefaultAzureCredential; 
            subscriptions: { subscriptionId: string; displayName: string }[]; 
        }
    ) {
        this.userSessions.set(userAccountId, session);
    }

    /**
     * ✅ Helper Function: Fetches resource groups for a subscription
     */
    private async fetchResourceGroups(azureCredential: DefaultAzureCredential, subscriptionId: string) {
        try {
            const resourceClient = new ResourceManagementClient(azureCredential, subscriptionId);
            const rgList = [];
    
            for await (const rg of resourceClient.resourceGroups.list()) {
                rgList.push(rg);
            }
    
            return rgList.map(rg => ({
                resourceGroupName: rg.name!
            }));
        } catch (error) {
            console.error(`❌ Failed to fetch resource groups for subscription ${subscriptionId}:`, error);
            return [];
        }
    }  
    
    async getResourceGroupsForSubscription(provider: "azure", userId: string, subscriptionId: string) {
        try {
            if (provider !== "azure") {
                throw new Error("❌ Invalid provider. This function only supports Azure.");
            }
    
            console.log(`📤 Fetching resource groups for Subscription ID: ${subscriptionId} and User ID: ${userId}`);
    
            // ✅ Ensure the user session exists
            const userSession = this.userSessions.get(userId);
            if (!userSession || !userSession.azureCredential) {
                throw new Error("❌ Azure credentials not found. User may need to reauthenticate.");
            }
    
            // ✅ Fetch resource groups dynamically
            const resourceGroups = await this.fetchResourceGroups(userSession.azureCredential, subscriptionId);
    
            if (!resourceGroups || resourceGroups.length === 0) {
                console.warn(`⚠️ No resource groups found for subscription ${subscriptionId}.`);
            } else {
                console.log(`✅ Retrieved ${resourceGroups.length} resource groups for subscription ${subscriptionId}.`);
            }
    
            return resourceGroups;
        } catch (error) {
            console.error(`❌ Error fetching resource groups for subscription ${subscriptionId}:`, error);
            return []; // Return an empty list to prevent crashes
        }
    }    

    /**
     * ✅ Handles authentication for Azure users.
     */
    async authenticate() {
        try {
            vscode.window.showInformationMessage("🔑 Connecting to Azure...");
    
            // Request Microsoft authentication session
            const session = await vscode.authentication.getSession(
                "microsoft",
                ["https://management.azure.com/user_impersonation"],
                { createIfNone: true }
            );
    
            if (!session) {
                throw new Error("Azure authentication session not found.");
            }
    
            console.log("✅ Azure authentication successful:", session);
    
            // Initialize Azure credentials
            const azureCredential = new DefaultAzureCredential();
    
            // Fetch all subscription IDs and names
            const subscriptionClient = new SubscriptionClient(azureCredential);
            const subscriptionsList = await subscriptionClient.subscriptions.list();
            const subscriptions: { subscriptionId: string; displayName: string }[] = [];
    
            for await (const subscription of subscriptionsList) {
                if (subscription.subscriptionId && subscription.displayName) {
                    subscriptions.push({
                        subscriptionId: subscription.subscriptionId,
                        displayName: subscription.displayName
                    });
                }
            }
    
            if (subscriptions.length === 0) {
                throw new Error("No active Azure subscriptions found.");
            }
    
            console.log(`🔹 Retrieved Azure Subscriptions:`, subscriptions);
    
            // ✅ Fetch resource groups for the first subscription (if available)
            let resourceGroups: { [subscriptionId: string]: { resourceGroupName: string }[] } = {};
            if (subscriptions.length > 0) {
                const firstSubscriptionId = subscriptions[0].subscriptionId;
                resourceGroups[firstSubscriptionId] = await this.getResourceGroupsForSubscription("azure", session.account.id, firstSubscriptionId);
                console.log(`✅ Retrieved resource groups for first subscription: ${firstSubscriptionId}`, resourceGroups[firstSubscriptionId]);
            }
    
            // ✅ Store subscriptions and the first subscription's resource groups
            this.userSessions.set(session.account.id, { azureCredential, subscriptions });
    
            vscode.window.showInformationMessage(`✅ Logged in as ${session.account.label}`);
    
            // ✅ Return subscriptions and resource groups for the first subscription
            return {
                userAccountId: session.account.id, // Unique Azure user ID
                subscriptions,
                resourceGroups
            };
        } catch (error) {
            console.error("❌ Azure Authentication failed:", error);
            vscode.window.showErrorMessage(`Azure login failed: ${error}`);
            throw error;
        }
    }
    
    
    /**
     * Creates a new Azure virtual machine instance.
     * @param userId Unique ID for Azure session.
     * @param params Instance parameters (resourceGroupName, vmName, groupId).
     */
    async createInstance(userId: string, params: { groupId?: string }) {
        
    }    

    /**
     * Stops an Azure virtual machine.
     * @param userId Unique ID for Azure session.
     * @param instanceId The ID of the VM to be stopped.
     */
    async stopInstance(userId: string, instanceId: string) {
        
    }

    /**
     * Fetches all instances for an Azure user.
     * @param userId Unique ID for Azure session.
     */
    async fetchInstances(userId: string) {
        return "hello";
    }
}
