import { window } from "vscode";
import { DefaultAzureCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { ResourceManagementClient } from "@azure/arm-resources";
import { NetworkManagementClient } from "@azure/arm-network";

export class AzureManager {
    private userSessions: Map<string, { azureCredential: DefaultAzureCredential; subscriptionId: string }> = new Map();

    /**
     * Handles authentication for Azure users.
     * @param userId Unique ID for Azure session.
     * @param credentials User authentication details.
     */
    async authenticate() {
        return "hello";
    }

    /**
     * Creates a new Azure virtual machine instance.
     * @param userId Unique ID for Azure session.
     * @param params Instance parameters (resourceGroupName, vmName, groupId).
     */
    async createInstance(userId: string, params: { groupId?: string }) {
        const session = this.userSessions.get(userId);
        if (!session) {
            window.showErrorMessage("Please authenticate first.");
            return;
        }
    
        try {
            const { subscriptionId, azureCredential } = session;
            const computeClient = new ComputeManagementClient(azureCredential, subscriptionId);
            const resourceGroupName = `rg-${userId}`;
            const vmName = `vm-${userId}-${Date.now()}`;
    
            // Ensure resource group exists
            const resourceClient = new ResourceManagementClient(azureCredential, subscriptionId);
            await resourceClient.resourceGroups.createOrUpdate(resourceGroupName, { location: "eastus" });
    
            // Create Virtual Machine
            await computeClient.virtualMachines.beginCreateOrUpdateAndWait(resourceGroupName, vmName, {
                location: "eastus",
                hardwareProfile: { vmSize: "Standard_B1s" },
                osProfile: { adminUsername: "azureuser", computerName: vmName, linuxConfiguration: { disablePasswordAuthentication: true } },
                storageProfile: { imageReference: { publisher: "Canonical", offer: "UbuntuServer", sku: "18.04-LTS", version: "latest" } },
            });
    
            // Store instance in DB    
            window.showInformationMessage(`✅ Azure VM ${vmName} created successfully!`);
            return { instanceId: vmName, userId, groupId: params.groupId };
        } catch (error) {
            console.error("❌ Error creating Azure instance:", error);
            window.showErrorMessage("Failed to create Azure VM.");
            return null;
        }
    }    

    /**
     * Stops an Azure virtual machine.
     * @param userId Unique ID for Azure session.
     * @param instanceId The ID of the VM to be stopped.
     */
    async stopInstance(userId: string, instanceId: string) {
        const session = this.userSessions.get(userId);
        if (!session) {
            window.showErrorMessage("Please authenticate first.");
            return;
        }

        try {
            const computeClient = new ComputeManagementClient(session.azureCredential, session.subscriptionId);
            await computeClient.virtualMachines.beginDeallocateAndWait(instanceId.split("/")[4], instanceId.split("/")[8]);
            window.showInformationMessage(`✅ VM ${instanceId} stopped.`);
        } catch (error) {
            console.error("❌ Error stopping Azure VM:", error);
            window.showErrorMessage("Failed to stop Azure VM.");
        }
    }

    /**
     * Fetches all instances for an Azure user.
     * @param userId Unique ID for Azure session.
     */
    async fetchInstances(userId: string) {
        return "hello";
    }
}
