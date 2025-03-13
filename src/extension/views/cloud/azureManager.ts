import * as vscode from "vscode";
import { DefaultAzureCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { ResourceManagementClient } from "@azure/arm-resources";
import { NetworkManagementClient } from "@azure/arm-network";
import { SubscriptionClient } from "@azure/arm-subscriptions";

export class AzureManager {
    // ✅ Store both subscriptionId and displayName
    private userSessions: Map<string, { 
        azureCredential: DefaultAzureCredential; 
        subscriptions: { subscriptionId: string; displayName: string }[] 
    }> = new Map();

    getUserSession(userAccountId: string) {
        return this.userSessions.get(userAccountId);
    }

    updateUserSession(
        userAccountId: string, 
        session: { 
            azureCredential: DefaultAzureCredential; 
            subscriptions: { subscriptionId: string; displayName: string }[] 
        }
    ) {
        this.userSessions.set(userAccountId, session);
    }

    /**
     * Handles authentication for Azure users.
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

            // Extract access token
            const accessToken = session.accessToken;

            // Initialize Azure credentials using the VS Code authentication session
            const azureCredential = new DefaultAzureCredential();

            // Fetch all subscription IDs and names using Azure SDK
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

            // Store session details with both ID and Display Name
            this.userSessions.set(session.account.id, { azureCredential, subscriptions });

            vscode.window.showInformationMessage(`✅ Logged in as ${session.account.label}`);

            // Return authentication details with subscriptions list
            return {
                userAccountId: session.account.id, // Unique Azure user ID
                subscriptions
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
