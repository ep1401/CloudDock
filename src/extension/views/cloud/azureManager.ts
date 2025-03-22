import * as vscode from "vscode";
import { DefaultAzureCredential } from "@azure/identity";
import { AccessToken, TokenCredential } from "@azure/core-auth";
import { ComputeManagementClient } from "@azure/arm-compute";
import { ResourceManagementClient } from "@azure/arm-resources";
import { NetworkManagementClient } from "@azure/arm-network";
import { SubscriptionClient } from "@azure/arm-subscriptions";
import { ConsumptionManagementClient } from "@azure/arm-consumption";

export class RefreshableVSCodeSessionCredential implements TokenCredential {
    private currentToken: AccessToken | null = null;

    constructor(private accountId: string) {}

    async getToken(): Promise<AccessToken> {
        if (!this.currentToken || this.currentToken.expiresOnTimestamp < Date.now()) {
            const session = await vscode.authentication.getSession(
                "microsoft",
                ["https://management.azure.com/user_impersonation"],
                { createIfNone: true }
            );

            if (!session) {
                throw new Error("User must be logged in to Azure.");
            }

            this.currentToken = {
                token: session.accessToken,
                expiresOnTimestamp: Date.now() + 60 * 60 * 1000
            };
        }

        return this.currentToken;
    }
}

export class AzureManager {
    // ✅ Store both subscriptions and resource groups
    private userSessions: Map<string, { 
        azureCredential: TokenCredential; 
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
    private async fetchResourceGroups(azureCredential: TokenCredential, subscriptionId: string) {
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
    
            // Step 1: Authenticate with VS Code's Microsoft session
            const session = await vscode.authentication.getSession(
                "microsoft",
                ["https://management.azure.com/user_impersonation"],
                { createIfNone: true }
            );
    
            if (!session) {
                throw new Error("Azure authentication session not found.");
            }
    
            console.log("✅ Azure authentication successful:", session);
    
            // Step 2: Use fast credential from VS Code
            const azureCredential = new RefreshableVSCodeSessionCredential(session.account.id);
    
            // Step 3: Fetch all subscriptions
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
    
            console.log("🔹 Retrieved Azure Subscriptions:", subscriptions);
    
            // Step 4: Cache credential and subscriptions right away
            this.userSessions.set(session.account.id, { azureCredential, subscriptions });
    
            const firstSubId = subscriptions[0].subscriptionId;
    
            // Step 5: Fetch VMs, resource groups, and cost in parallel
            const [resourceGroupsList, vms, cost] = await Promise.all([
                this.getResourceGroupsForSubscription("azure", session.account.id, firstSubId),
                this.getUserVMs(session.account.id),
                this.getMonthlyCost(session.account.id) // ← Now fetched in parallel
            ]);
    
            vscode.window.showInformationMessage("Total cost: " + cost);
    
            const resourceGroups: { [subscriptionId: string]: { resourceGroupName: string }[] } = {
                [firstSubId]: resourceGroupsList
            };
    
            vscode.window.showInformationMessage(`✅ Logged in as ${session.account.label}`);
    
            return {
                userAccountId: session.account.id,
                subscriptions,
                resourceGroups,
                cost,
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

        // Create a Virtual Network with a Subnet (await to get subnet ID)
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

        // 🚀 Start VM creation asynchronously (non-blocking)
        const vmPoller = await computeClient.virtualMachines.beginCreateOrUpdate(
            params.resourceGroup,
            params.vmName,
            vmParams
        );

        return params.vmName; // Returning the VM name immediately
    }


    async getUserVMs(userId: string) {
        const userSession = this.userSessions.get(userId);
        if (!userSession || !userSession.azureCredential) {
            throw new Error("No authenticated session found for the provided userId. Please authenticate first.");
        }
    
        const azureCredential = userSession.azureCredential;
        const allowedRegions = new Set(["eastus", "westus", "westeurope", "southeastasia"]);
        const vms: any[] = [];
    
        // Step 1: Fetch VMs across all subscriptions in parallel
        const subscriptionVMFetches = userSession.subscriptions.map(async (subscription) => {
            const computeClient = new ComputeManagementClient(azureCredential, subscription.subscriptionId);
    
            // Collect all VMs for the subscription
            const vmList = [];
            for await (const vm of computeClient.virtualMachines.listAll()) {
                if (!vm.id || !vm.name || !vm.location || !allowedRegions.has(vm.location.toLowerCase())) {
                    continue;
                }
                vmList.push({ vm, computeClient, subscriptionId: subscription.subscriptionId });
            }
    
            return vmList;
        });
    
        // Wait for all subscription-level VM lists to finish
        const allVMsBySubscription = await Promise.all(subscriptionVMFetches);
    
        // Step 2: Flatten and fetch instance views in parallel
        const instanceFetches = allVMsBySubscription.flat().map(async ({ vm, computeClient, subscriptionId }) => {
            const resourceGroup = vm.id ? vm.id.split("/")[4] : "";
    
            try {
                if (!vm.name) {
                    throw new Error(`VM name is undefined for VM with ID ${vm.id}`);
                }
                const vmInstanceView = await computeClient.virtualMachines.instanceView(resourceGroup, vm.name);
    
                return {
                    id: vm.id,
                    name: vm.name,
                    status: vmInstanceView.statuses?.[1]?.displayStatus || "Unknown",
                    region: vm.location,
                    subscriptionId
                };
            } catch (error) {
                console.warn(`⚠️ Failed to retrieve instance view for VM ${vm.name}:`, error);
                return {
                    id: vm.id,
                    name: vm.name,
                    status: "Unknown (Error fetching status)",
                    region: vm.location,
                    subscriptionId
                };
            }
        });
    
        const vmResults = await Promise.all(instanceFetches);
        return vmResults;
    }
    

    /**
     * Stops an Azure virtual machine.
     * @param userId Unique ID for Azure session.
     * @param instanceId The ID of the VM to be stopped.
     */
    async stopVMs(userId: string, vms: { vmId: string; subscriptionId: string }[]) {
        const userSession = this.userSessions.get(userId);
        if (!userSession || !userSession.azureCredential) {
            throw new Error("No authenticated session found for the provided userId. Please authenticate first.");
        }
        
        const azureCredential = userSession.azureCredential;
        let stoppedVMs: { vmId: string; subscriptionId: string }[] = [];
        
        for (const { vmId, subscriptionId } of vms) {
            try {
                const vmDetails = vmId.split("/");
                const resourceGroup = vmDetails[4]; // Extracting resource group from VM ID
                const vmName = vmDetails[8]; // Extracting VM name from VM ID
    
                console.log(`🛑 Stopping VM: ${vmName} in Resource Group: ${resourceGroup}, Subscription: ${subscriptionId}`);
                const computeClient = new ComputeManagementClient(azureCredential, subscriptionId);
                await computeClient.virtualMachines.beginPowerOffAndWait(resourceGroup, vmName);
                stoppedVMs.push({ vmId, subscriptionId });
            } catch (error) {
                console.error(`❌ Failed to stop VM with ID ${vmId}:`, error);
            }
        }
    
        return stoppedVMs;
    }

    async startVMs(userId: string, vms: { vmId: string; subscriptionId: string }[]) {
        const userSession = this.userSessions.get(userId);
        if (!userSession || !userSession.azureCredential) {
            throw new Error("No authenticated session found for the provided userId. Please authenticate first.");
        }
        
        const azureCredential = userSession.azureCredential;
        let startedVMs: { vmId: string; subscriptionId: string }[] = [];
        
        for (const { vmId, subscriptionId } of vms) {
            try {
                const vmDetails = vmId.split("/");
                const resourceGroup = vmDetails[4]; // Extracting resource group from VM ID
                const vmName = vmDetails[8]; // Extracting VM name from VM ID
    
                console.log(`🚀 Starting VM: ${vmName} in Resource Group: ${resourceGroup}, Subscription: ${subscriptionId}`);
                const computeClient = new ComputeManagementClient(azureCredential, subscriptionId);
                await computeClient.virtualMachines.beginStartAndWait(resourceGroup, vmName);
                startedVMs.push({ vmId, subscriptionId });
            } catch (error) {
                console.error(`❌ Failed to start VM with ID ${vmId}:`, error);
            }
        }
    
        return startedVMs;
    }

    async deleteVMs(userId: string, vms: { vmId: string; subscriptionId: string }[]) {
        const userSession = this.userSessions.get(userId);
        if (!userSession || !userSession.azureCredential) {
            throw new Error("No authenticated session found for the provided userId. Please authenticate first.");
        }
        
        const azureCredential = userSession.azureCredential;
        let deletedVMs: { vmId: string; subscriptionId: string }[] = [];
        
        for (const { vmId, subscriptionId } of vms) {
            try {
                const vmDetails = vmId.split("/");
                const resourceGroup = vmDetails[4]; // Extracting resource group from VM ID
                const vmName = vmDetails[8]; // Extracting VM name from VM ID
    
                console.log(`🗑️ Deleting VM: ${vmName} in Resource Group: ${resourceGroup}, Subscription: ${subscriptionId}`);
                const computeClient = new ComputeManagementClient(azureCredential, subscriptionId);
                await computeClient.virtualMachines.beginDeleteAndWait(resourceGroup, vmName);
                deletedVMs.push({ vmId, subscriptionId });
            } catch (error) {
                console.error(`❌ Failed to delete VM with ID ${vmId}:`, error);
            }
        }
    
        return deletedVMs;
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

    async getMonthlyCost(userId: string): Promise<string> {
        try {
            const userSession = this.userSessions.get(userId);
            if (!userSession || !userSession.azureCredential || userSession.subscriptions.length === 0) {
                throw new Error("❌ No valid Azure session or subscriptions found for user.");
            }
    
            const now = new Date();
            const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
            const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
            const filter = `usageStart ge '${startDate}' and usageEnd lt '${endDate}'`;
    
            const costPromises = userSession.subscriptions.map(async ({ subscriptionId }) => {
                const scope = `/subscriptions/${subscriptionId}`;
                const consumptionClient = new ConsumptionManagementClient(userSession.azureCredential, subscriptionId);
    
                let subTotal = 0;
    
                try {
                    for await (const item of consumptionClient.usageDetails.list(scope, { filter })) {
                        if (
                            item &&
                            typeof item === "object" &&
                            "costInUSD" in item &&
                            typeof item.costInUSD === "number"
                        ) {
                            subTotal += item.costInUSD;
                        }
                    }
    
                    console.log(`✅ Retrieved cost for subscription ${subscriptionId}: $${subTotal.toFixed(2)}`);
                    return subTotal;
                } catch (subError) {
                    if (subError instanceof Error) {
                        console.warn(`⚠️ Skipping subscription ${subscriptionId} due to error:`, subError.message);
                    } else {
                        console.warn(`⚠️ Skipping subscription ${subscriptionId} due to unknown error:`, subError);
                    }
                    return 0; // fallback if this sub fails
                }
            });
    
            const costResults = await Promise.all(costPromises);
            const totalCost = costResults.reduce((sum, cost) => sum + cost, 0);
            const formattedCost = `$${totalCost.toFixed(2)}`;
    
            console.log(`💰 Total monthly cost across accessible subscriptions: ${formattedCost}`);
            return formattedCost;
        } catch (error) {
            console.error("❌ Failed to retrieve monthly cost:", error);
            return "Unavailable";
        }
    }          
}
