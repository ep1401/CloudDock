import * as vscode from "vscode";
import { DefaultAzureCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { ResourceManagementClient } from "@azure/arm-resources";
import { NetworkManagementClient } from "@azure/arm-network";
import { SubscriptionClient } from "@azure/arm-subscriptions";

export class AzureManager {
    private userSessions: Map<string, { azureCredential: DefaultAzureCredential; subscriptionIds: string[] }> = new Map();

    getUserSession(userAccountId: string) {
        return this.userSessions.get(userAccountId);
    }

    updateUserSession(userAccountId: string, session: { azureCredential: DefaultAzureCredential; subscriptionIds: string[] }) {
        this.userSessions.set(userAccountId, session);
    }

    /**
     * Handles authentication for Azure users.
     * @param userId Unique ID for Azure session.
     * @param credentials User authentication details.
     */
    async authenticate() {
        try {
            vscode.window.showInformationMessage("🔑 Logging you in to Azure...");

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

            // Fetch all subscription IDs using Azure SDK
            const subscriptionClient = new SubscriptionClient(azureCredential);
            const subscriptions = await subscriptionClient.subscriptions.list();
            const subscriptionIds: string[] = [];

            for await (const subscription of subscriptions) {
                if (subscription.subscriptionId) {
                    subscriptionIds.push(subscription.subscriptionId);
                }
            }

            if (subscriptionIds.length === 0) {
                throw new Error("No active Azure subscriptions found.");
            }

            console.log(`🔹 Retrieved Azure Subscription IDs:`, subscriptionIds);

            // Store session details, now with all subscription IDs
            this.userSessions.set(session.account.id, { azureCredential, subscriptionIds });

            vscode.window.showInformationMessage(`✅ Logged in as ${session.account.label}`);

            // Return authentication details
            return {
                userAccountId: session.account.id, // Unique Azure user ID
                subscriptionIds
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
