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

            const vms = await this.getUserVMs(session.account.id);

            vscode.window.showInformationMessage(`✅ Logged in as ${session.account.label}`);
    
            // ✅ Return subscriptions and resource groups for the first subscription
            return {
                userAccountId: session.account.id, // Unique Azure user ID
                subscriptions,
                resourceGroups,
                vms
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
        /**
     * Creates a new Azure virtual machine instance with a public IP address.
     * @param params Instance parameters (subscriptionId, resourceGroup, region, userId, sshKey, vmName).
     */
    async createInstance(params: {
        subscriptionId: string;
        resourceGroup: string;
        region: string;
        userId: string;
        sshKey: string;
        vmName: string;
    }): Promise<string> {
        // Retrieve the authenticated session for the provided userId.
        const userSession = this.userSessions.get(params.userId);
        if (!userSession || !userSession.azureCredential) {
            throw new Error("No authenticated session found for the provided userId. Please authenticate first.");
        }
        const azureCredential = userSession.azureCredential;
    
        // Initialize management clients.
        const computeClient = new ComputeManagementClient(azureCredential, params.subscriptionId);
        const networkClient = new NetworkManagementClient(azureCredential, params.subscriptionId);
    
        // Generate unique names for resources.
        const timestamp = Date.now();
        const uniqueSuffix = timestamp.toString();
        const nicName = `nic-${uniqueSuffix}`;
        const vnetName = `vnet-${uniqueSuffix}`;
        const subnetName = `subnet-${uniqueSuffix}`;
        const nsgName = `nsg-${uniqueSuffix}`;
        const publicIpName = `pip-${uniqueSuffix}`;
    
        // Create a Virtual Network with a Subnet.
        const vnetParams = {
            location: params.region,
            addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
            subnets: [{ name: subnetName, addressPrefix: "10.0.0.0/24" }]
        };
        const vnetResult = await networkClient.virtualNetworks.beginCreateOrUpdateAndWait(
            params.resourceGroup,
            vnetName,
            vnetParams
        );
        const subnet = vnetResult.subnets?.[0];
        if (!subnet?.id) {
            throw new Error("Failed to retrieve subnet information from the virtual network.");
        }
    
        // Create a Network Security Group with an SSH rule.
        const nsgParams = {
            location: params.region,
            securityRules: [
                {
                    name: "allow-ssh",
                    protocol: "Tcp",
                    sourcePortRange: "*",
                    destinationPortRange: "22",
                    sourceAddressPrefix: "*",
                    destinationAddressPrefix: "*",
                    access: "Allow",
                    priority: 1000,
                    direction: "Inbound"
                }
            ]
        };
        const nsgResult = await networkClient.networkSecurityGroups.beginCreateOrUpdateAndWait(
            params.resourceGroup,
            nsgName,
            nsgParams
        );
    
        // Create a Public IP Address.
        const publicIpParams = {
            location: params.region,
            publicIPAllocationMethod: "Static"
        };
        const publicIpResult = await networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(
            params.resourceGroup,
            publicIpName,
            publicIpParams
        );
    
        if (!publicIpResult?.id) {
            throw new Error("Failed to create Public IP Address.");
        }
    
        // Create a Network Interface with the public IP.
        const nicParams = {
            location: params.region,
            ipConfigurations: [
                {
                    name: "ipconfig1",
                    subnet: { id: subnet.id },
                    publicIPAddress: { id: publicIpResult.id },
                    privateIPAllocationMethod: "Dynamic"
                }
            ],
            networkSecurityGroup: { id: nsgResult.id }
        };
        const nicResult = await networkClient.networkInterfaces.beginCreateOrUpdateAndWait(
            params.resourceGroup,
            nicName,
            nicParams
        );
    
        if (!nicResult?.id) {
            throw new Error("Failed to create Network Interface.");
        }
    
        // Create the Virtual Machine with the SSH key for secure access.
        const vmParams = {
            location: params.region,
            hardwareProfile: {
                vmSize: "Standard_B1s"
            },
            osProfile: {
                computerName: params.vmName,
                adminUsername: "azureuser",
                linuxConfiguration: {
                    disablePasswordAuthentication: true,
                    ssh: {
                        publicKeys: [
                            {
                                path: `/home/azureuser/.ssh/authorized_keys`,
                                keyData: params.sshKey
                            }
                        ]
                    }
                }
            },
            networkProfile: {
                networkInterfaces: [
                    { id: nicResult.id, primary: true }
                ]
            },
            storageProfile: {
                imageReference: {
                    publisher: "Canonical",
                    offer: "UbuntuServer",
                    sku: "18.04-LTS",
                    version: "latest"
                },
                osDisk: {
                    createOption: "FromImage"
                }
            }
        };
    
        const vmResult = await computeClient.virtualMachines.beginCreateOrUpdateAndWait(
            params.resourceGroup,
            params.vmName,
            vmParams
        );
    
        if (!vmResult.id) {
            throw new Error("Failed to create VM: VM ID is undefined.");
        }
    
        vscode.window.showInformationMessage(`✅ Azure VM created successfully. VM ID: ${vmResult.id}`);
        return vmResult.id;
    }

    async getUserVMs(userId: string) {
        const userSession = this.userSessions.get(userId);
        if (!userSession || !userSession.azureCredential) {
            throw new Error("No authenticated session found for the provided userId. Please authenticate first.");
        }
        
        const azureCredential = userSession.azureCredential;
        const allowedRegions = ["eastus", "westus", "westeurope", "southeastasia"];
        const vms: any[] = [];
    
        for (const subscription of userSession.subscriptions) {
            const computeClient = new ComputeManagementClient(azureCredential, subscription.subscriptionId);
    
            for await (const vm of computeClient.virtualMachines.listAll()) {
                if (!vm.id || !vm.name || !vm.location || !allowedRegions.includes(vm.location.toLowerCase())) {
                    continue; // Skip invalid or disallowed region VMs
                }
    
                const resourceGroup = vm.id.split("/")[4];
    
                try {
                    const vmInstanceView = await computeClient.virtualMachines.instanceView(resourceGroup, vm.name);
    
                    vms.push({
                        id: vm.id,
                        name: vm.name,
                        status: vmInstanceView.statuses?.[1]?.displayStatus || "Unknown",
                        region: vm.location
                    });
                } catch (error) {
                    console.warn(`⚠️ Failed to retrieve instance view for VM ${vm.name}:`, error);
                    vms.push({
                        id: vm.id,
                        name: vm.name,
                        status: "Unknown (Error fetching status)",
                        region: vm.location
                    });
                }
            }
        }
    
        return vms;
    } 

    /**
     * Stops an Azure virtual machine.
     * @param userId Unique ID for Azure session.
     * @param instanceId The ID of the VM to be stopped.
     */
    async stopVMs(userId: string, vmIds: string[]) {
        const userSession = this.userSessions.get(userId);
        if (!userSession || !userSession.azureCredential) {
            throw new Error("No authenticated session found for the provided userId. Please authenticate first.");
        }
        
        const azureCredential = userSession.azureCredential;
        let stoppedVMs: string[] = [];
        
        for (const subscription of userSession.subscriptions) {
            const computeClient = new ComputeManagementClient(azureCredential, subscription.subscriptionId);
    
            for (const vmId of vmIds) {
                try {
                    const vmDetails = vmId.split("/");
                    const resourceGroup = vmDetails[4]; // Extracting resource group from VM ID
                    const vmName = vmDetails[8]; // Extracting VM name from VM ID
    
                    console.log(`🛑 Stopping VM: ${vmName} in Resource Group: ${resourceGroup}`);
                    await computeClient.virtualMachines.beginPowerOffAndWait(resourceGroup, vmName);
                    stoppedVMs.push(vmName);
                } catch (error) {
                    console.error(`❌ Failed to stop VM with ID ${vmId}:`, error);
                }
            }
        }
    
        return stoppedVMs;
    }

    /**
     * Fetches all instances for an Azure user.
     * @param userId Unique ID for Azure session.
     */
    async fetchInstances(userId: string) {
        return "hello";
    }

    async shutdownInstances(userId: string, instanceIds: string[]) {
        return "hello";
    }

    async startInstances(userId: string, instanceIds: string[]) {
        return "hello";
    }
}
