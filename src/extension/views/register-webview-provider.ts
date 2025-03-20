import { CancellationToken, ExtensionContext, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext, window } from "vscode";
import { CloudManager } from "./cloud/cloudManager";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import scheduler from "./backgroundScheduler";

export function registerWebViewProvider(context: ExtensionContext) {
    const provider = new SidebarWebViewProvider(context.extensionUri, context);
    context.subscriptions.push(window.registerWebviewViewProvider("infinite-poc-sidebar-panel", provider));
}

export class SidebarWebViewProvider implements WebviewViewProvider {
    private cloudManager = CloudManager.getInstance();
    private scheduler: typeof scheduler;

    // Map webview instances to their unique IDs
    private viewInstances: Map<string, WebviewView> = new Map();

    // Map webview IDs to user accounts
    private userSessions: Map<string, Record<string, string>> = new Map(); // Maps webviewId -> userId

    constructor(private readonly _extensionUri: Uri, public extensionContext: ExtensionContext) {
        this.scheduler = scheduler;
    }

    resolveWebviewView(webviewView: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken) {
        // Assign a unique ID to this webview
        const webviewId = uuidv4();
        this.viewInstances.set(webviewId, webviewView);

        this.userSessions.set(webviewId, {});

        webviewView.webview.options = { enableScripts: true };

        // Load HTML content dynamically
        const connectHtml = this.getHtmlContent("connect.html");
        const awsHtml = this.getHtmlContent("aws.html");
        const azureHtml = this.getHtmlContent("azure.html");
        const multiHtml = this.getHtmlContent("multi.html");

        webviewView.webview.html = this.getHtmlForWebview(connectHtml, awsHtml, azureHtml, multiHtml);

        // ✅ Delay sending message to ensure the WebView is ready
        setTimeout(() => {
            this.postMessage(webviewId, { type: "webviewInitialized", webviewId });
        }, 500);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            const { provider, type, payload, webviewId } = data;
            const userSession = this.userSessions.get(webviewId) || {}; 
            let userId = userSession[provider];

            try {
                switch (type) {
                    case "connect":
                        try {
                            const result = await this.cloudManager.connect(provider);

                            if (typeof result === "string") {
                                userId = result;
                            } else if (result && typeof result === "object" && "userAccountId" in result ) {
                                userId = result.userAccountId;

                                if (typeof userId === "string" && userId.trim().length > 0) {
                                    // ✅ Store userId for this webview
                                    userSession[provider] = userId;
                                    this.userSessions.set(webviewId, userSession);

                                    // ✅ Send messages to update UI
                                    this.postMessage(webviewId, { type: `${provider}Connected`, userId });
                                    if (provider == "aws") {
                                        if ('keyPairs' in result) {
                                            const { keyPairs } = result;
                                            this.postMessage(webviewId, { type: "updateKeyPairs", keyPairs, userId });
                                        }
                                        if ('ec2instances' in result) {
                                            const { ec2instances } = result;
                                            this.postMessage(webviewId, { type: "updateInstances", instances: ec2instances, userId });
                                        }
                                        if ('usergroups' in result) {
                                            const { usergroups } = result;
                                            const { awsGroups } = usergroups;
                                            console.log("awsgroup:", awsGroups);
                                            this.postMessage(webviewId, { type: "updateGroupsAWS", awsGroups, userId });
                                        }
                                        if ('cost' in result) {
                                            const { cost } = result;
                                            this.postMessage(webviewId, { type: "updateCosts", provider, cost, userId });
                                        }
                                     } else if (provider === "azure") {
                                        if ("subscriptions" in result && Array.isArray(result.subscriptions)) {
                                            console.log("🔑 Sending subscriptions to UI:", result.subscriptions);
                                            const { subscriptions } = result;
                                            this.postMessage(webviewId, { type: "updateSubscriptions", subscriptions, userId });
                                        }
                                        if ("resourceGroups" in result && typeof result.resourceGroups === "object") {
                                            console.log("📂 Sending resource groups to UI:", result.resourceGroups);
                                            const { resourceGroups } = result;
                                            this.postMessage(webviewId, { type: "updateResourceGroups", resourceGroups, userId });
                                        }
                                        if ("vms" in result && Array.isArray(result.vms)) {
                                            console.log("🖥 Sending VMs to UI:", result.vms);
                                            const { vms } = result;
                                            this.postMessage(webviewId, { type: "updateVMs", VMs: vms, userId });
                                        }
                                    }
                                }
                            } else {
                                console.error(`❌ Unexpected return value from cloudManager.connect:`, result);
                            }
                        } catch (error) {
                            console.error(`❌ Error during connection:`, error);
                            window.showErrorMessage(`Error connecting to ${provider}: ${error}`);
                        }
                        break;

                    case "changeRegion":
                        console.log(`🔹 Received changeRegion request for ${provider}:`, data);

                        if (!userId) {
                            console.error(`❌ No authenticated user found for region change`);
                            window.showErrorMessage("Please authenticate first.");
                            return;
                        }

                        if (!payload || !payload.region) {
                            console.error(`❌ No region provided.`);
                            window.showErrorMessage("Region selection is required.");
                            return;
                        }

                        console.log(`🔹 Changing region for ${provider}, userId: ${userId}, region: ${payload.region}`);

                        try {
                            const updatedKeyPairs = await this.cloudManager.changeRegion(provider, userId, payload.region);
                            this.postMessage(webviewId, { type: "updateKeyPairs", keyPairs: updatedKeyPairs, userId });
                            console.log(`✅ Successfully changed region for user ${userId}`);
                        } catch (error) {
                            console.error(`❌ Error changing region:`, error);
                            window.showErrorMessage(`Error changing region: ${error}`);
                        }
                        break;
                    case "createInstance":
                            console.log(`🔹 Received createInstance request from webview ${webviewId}:`, data);

                            if (!webviewId) {
                                console.error("❌ Missing webviewId in createInstance request.");
                                window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                                return;
                            }

                            // ✅ Retrieve the correct user ID based on the provider
                            const instanceUserId = userSession[provider]; 

                            if (!instanceUserId) {
                                console.error(`❌ No authenticated ${provider.toUpperCase()} user found. Please authenticate first.`);
                                window.showErrorMessage(`Please authenticate with ${provider.toUpperCase()} first!`);
                                return;
                            }

                            // ✅ Validate required parameters based on provider
                            if (provider === "aws") {
                                if (!payload || !payload.keyPair || !payload.region) {
                                    console.error("❌ Missing parameters for AWS instance creation.");
                                    window.showErrorMessage("Please select a key pair and region before creating an AWS instance.");
                                    return;
                                }
                                console.log(`📤 Creating AWS Instance for userId: ${instanceUserId} in region: ${payload.region} with key pair: ${payload.keyPair}`);

                                try {
                                    // ✅ Call `createInstance` for AWS
                                    window.showInformationMessage('Creating AWS Instance');
                                    const instanceId = await this.cloudManager.createInstance(provider, instanceUserId, {
                                        keyPair: payload.keyPair,
                                        region: payload.region
                                    });

                                    if (!instanceId) {
                                        console.error("❌ AWS Instance creation failed. No instance ID returned.");
                                        window.showErrorMessage("Failed to create AWS instance. Check logs for details.");
                                        return;
                                    }

                                    console.log(`✅ AWS Instance created successfully. Instance ID: ${instanceId}`);
                                    console.log("Instance ID Structure:", JSON.stringify(instanceId, null, 2));
                                    // ✅ Notify the webview about the created instance
                                    this.postMessage(webviewId, {
                                        type: "instanceCreated",
                                        instanceId: instanceId.instanceId, 
                                        instanceName: instanceId.instanceName, 
                                        userId: instanceUserId, 
                                        region: payload.region, 
                                    });

                                } catch (error) {
                                    console.error(`❌ Error creating AWS instance:`, error);
                                    window.showErrorMessage(`Error creating AWS instance: ${error}`);
                                }

                            } else if (provider === "azure") {
                                if (!payload || !payload.subscriptionId || !payload.resourceGroup || !payload.region || !payload.sshKey) {
                                    console.error("❌ Missing parameters for Azure VM creation.");
                                    window.showErrorMessage("Please select a subscription, resource group, region, and provide an SSH key before creating an Azure VM.");
                                    return;
                                }

                                console.log(`📤 Creating Azure VM for userId: ${instanceUserId} in region: ${payload.region}, Subscription: ${payload.subscriptionId}, Resource Group: ${payload.resourceGroup}`);

                                try {
                                    // ✅ Call `createInstance` for Azure
                                    window.showInformationMessage('Creating Azure Instance');
                                    const vmId = await this.cloudManager.createInstance(provider, instanceUserId, {
                                        subscriptionId: payload.subscriptionId,
                                        resourceGroup: payload.resourceGroup,
                                        region: payload.region,
                                        sshKey: payload.sshKey
                                    });

                                    if (!vmId) {
                                        console.error("❌ Azure VM creation failed. No VM ID returned.");
                                        window.showErrorMessage("Failed to create Azure VM. Check logs for details.");
                                        return;
                                    }

                                    console.log(`✅ Azure VM created successfully. VM ID: ${vmId}`);

                                    // ✅ Notify the webview about the created instance
                                    this.postMessage(webviewId, {
                                        type: "instanceCreated",
                                        instanceId: vmId,
                                        userId: instanceUserId,  
                                    });

                                } catch (error) {
                                    console.error(`❌ Error creating Azure VM:`, error);
                                    window.showErrorMessage(`Error creating Azure VM: ${error}`);
                                }
                            }
                            break;
                   
                    case "getResourceGroups":
                        try {
                            console.log("📤 Received request to fetch resource groups for Azure.");

                            if (!payload || !payload.subscriptionId) {
                                console.error("❌ Missing subscriptionId in request.");
                                window.showErrorMessage("Subscription ID is required to fetch resource groups.");
                                return;
                            }

                            const subscriptionId = payload.subscriptionId;
                            console.log(`🔹 Fetching resource groups for Subscription ID: ${subscriptionId}`);

                            // ✅ Ensure Azure user ID is retrieved correctly
                            const azureUserId = userSession["azure"];
                            if (!azureUserId) {
                                console.error("❌ No Azure user session found.");
                                window.showErrorMessage("Please authenticate with Azure first.");
                                return;
                            }

                            // ✅ Call the function from `cloudManager` to fetch resource groups
                            const resourceGroups = await this.cloudManager.getResourceGroupsForSubscription("azure", azureUserId, subscriptionId);

                            if (!resourceGroups || !Array.isArray(resourceGroups)) {
                                console.warn("⚠️ No resource groups returned.");
                                window.showErrorMessage("No resource groups found for this subscription.");
                                return;
                            }

                            console.log(`✅ Retrieved ${resourceGroups.length} resource groups for subscription ${subscriptionId}.`);

                            // ✅ Send resource groups back to the UI
                            this.postMessage(webviewId, { 
                                type: "updateResourceGroups", 
                                resourceGroups: { [subscriptionId]: resourceGroups }, 
                                userId: azureUserId  // ✅ Send the correct Azure user ID
                            });

                        } catch (error) {
                            console.error(`❌ Error fetching resource groups:`, error);
                            window.showErrorMessage(`Error fetching resource groups: ${error}`);
                        }
                        break;
                    
                    case "shutdownInstances":
                        console.log("📩 Received shutdownInstances message:", data); // Debugging log

                        // Ensure AWS user session exists
                        if (!userSession["aws"]) {
                            console.error("❌ No authenticated AWS user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with AWS first!");
                            return;
                        }

                        const userIdAWS = userSession["aws"];

                        // 🔥 Fix: Ensure `payload` exists and contains `instanceIds`
                        if (!payload || !payload.instanceIds || !Array.isArray(payload.instanceIds) || payload.instanceIds.length === 0) {
                            console.warn("❌ Invalid shutdown request: No instance IDs provided.");
                            window.showErrorMessage("No instances selected for shutdown.");
                            return;
                        }

                        const instanceIds = payload.instanceIds;

                        console.log(`📤 Initiating shutdown for AWS instances (User: ${userIdAWS}):`, instanceIds);
                        window.showInformationMessage(`Stopping ${instanceIds.length} instance(s): ${instanceIds.join(", ")}`);

                        try {
                            // ✅ Call `shutdownInstances` in CloudManager
                            await this.cloudManager.shutdownInstances(userIdAWS, instanceIds);
                            console.log(`✅ Successfully initiated shutdown for instances: ${instanceIds.join(", ")}`);
                            this.postMessage(webviewId, { 
                                type: "stoppedResources", 
                                stoppedInstances: payload.instanceIds, 
                                userId: userIdAWS
                            });
                        } catch (error) {
                            console.error(`❌ Error shutting down instances for user ${userIdAWS}:`, error);
                            window.showErrorMessage(`Error shutting down instances: ${error}`);
                        }
                        break;

                    case "stopVMs":
                        console.log("📩 Received stopVMs message:", data); // Debugging log

                        // Ensure Azure user session exists
                        if (!userSession["azure"]) {
                            console.error("❌ No authenticated Azure user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with Azure first!");
                            return;
                        }

                        const userIdAzure = userSession["azure"];

                        // 🔥 Fix: Ensure `payload` exists and contains valid `vms` array
                        if (!payload || !payload.vms || !Array.isArray(payload.vms) || payload.vms.length === 0) {
                            console.warn("❌ Invalid shutdown request: No VM IDs provided.");
                            window.showErrorMessage("No VMs selected for shutdown.");
                            return;
                        }

                        // Extract VM IDs and Subscription IDs
                        const vmsToStop = payload.vms.map((vm: { vmId: string; subscriptionId: string }) => ({
                            vmId: vm.vmId,
                            subscriptionId: vm.subscriptionId
                        }));                        

                        console.log(`📤 Initiating shutdown for Azure VMs (User: ${userIdAzure}):`, vmsToStop);
                        window.showInformationMessage(`Stopping ${vmsToStop.length} VM(s)...`);

                        try {
                            // ✅ Call `stopVMs` in `CloudManager` and pass VM IDs and Subscription IDs
                            await this.cloudManager.stopVMs(userIdAzure, vmsToStop);
                            console.log(`✅ Successfully initiated shutdown for VMs:`, vmsToStop);

                            // ✅ Notify webview that VMs were stopped
                            this.postMessage(webviewId, { 
                                type: "stoppedVMs", 
                                stoppedVMs: vmsToStop, 
                                userId: userIdAzure
                            });

                        } catch (error) {
                            console.error(`❌ Error shutting down VMs for user ${userIdAzure}:`, error);
                            window.showErrorMessage(`Error shutting down VMs: ${error}`);
                        }
                        break;

                    case "refreshawsinstances":
                        console.log("📩 Received request to refresh AWS instances");

                        if (!userSession["aws"]) {
                            console.error("❌ No authenticated AWS user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with AWS first!");
                            return;
                        }

                        const userIdAWSRef = userSession["aws"];

                        try {
                            // ✅ Call the function in CloudManager to fetch updated instances
                            const updatedInstances = await this.cloudManager.refreshAWSInstances(userIdAWSRef);
                            window.showInformationMessage("Refreshing AWS Instances...");

                            // ✅ Send the updated instance list back to the Webview
                            this.postMessage(webviewId, { 
                                type: "updateInstances", 
                                instances: updatedInstances, 
                                userId: userIdAWSRef 
                            });

                            console.log("✅ Successfully refreshed AWS instances");

                        } catch (error) {
                            console.error(`❌ Error refreshing AWS instances for user ${userIdAWSRef}:`, error);
                            window.showErrorMessage(`Error refreshing AWS instances: ${error}`);
                        }
                        break;
                    case "terminateInstances":
                        console.log("📩 Received terminateInstances message:", data); // Debugging log

                        if (!userSession["aws"]) {
                            console.error("❌ No authenticated AWS user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with AWS first!");
                            return;
                        }

                        const userIdAWSter = userSession["aws"];

                        // 🔥 Ensure `payload` exists and contains `instanceIds`
                        if (!payload || !payload.instanceIds || !Array.isArray(payload.instanceIds) || payload.instanceIds.length === 0) {
                            console.warn("❌ Invalid terminate request: No instance IDs provided.");
                            window.showErrorMessage("No instances selected for termination.");
                            return;
                        }

                        const instanceIdster = payload.instanceIds;

                        console.log(`📤 Terminating AWS Instances for userId: ${userIdAWSter}`, instanceIdster);
                        window.showInformationMessage(`Terminating ${instanceIdster.length} instance(s): ${instanceIdster.join(", ")}`);

                        try {
                            // ✅ Call `terminateAWSInstances` in CloudManager
                            await this.cloudManager.terminateAWSInstances(userIdAWSter, instanceIdster);
                            console.log(`✅ Successfully initiated termination for instances: ${instanceIdster.join(", ")}`);

                            // ✅ Send a message back to the Webview to update the UI
                            this.postMessage(webviewId, { 
                                type: "terminatedResources", 
                                terminatedInstances: instanceIdster, 
                                userId: userIdAWSter
                            });

                        } catch (error) {
                            console.error(`❌ Error terminating instances for user ${userIdAWSter}:`, error);
                            window.showErrorMessage(`Error terminating instances: ${error}`);
                        }
                        break;
                    case "startInstances":
                        console.log("📩 Received startInstances message:", data); // Debugging log

                        if (!userSession["aws"]) {
                            console.error("❌ No authenticated AWS user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with AWS first!");
                            return;
                        }

                        const userIdAWSstart = userSession["aws"];

                        // 🔥 Ensure `payload` exists and contains `instanceIds`
                        if (!payload || !payload.instanceIds || !Array.isArray(payload.instanceIds) || payload.instanceIds.length === 0) {
                            console.warn("❌ Invalid start request: No instance IDs provided.");
                            window.showErrorMessage("No instances selected for starting.");
                            return;
                        }

                        const instanceIdsStart = payload.instanceIds;

                        console.log(`📤 Starting AWS Instances for userId: ${userIdAWSstart}`, instanceIdsStart);
                        window.showInformationMessage(`Starting ${instanceIdsStart.length} instance(s): ${instanceIdsStart.join(", ")}`);

                        try {
                            // ✅ Call `startAWSInstances` in CloudManager
                            await this.cloudManager.startAWSInstances(userIdAWSstart, instanceIdsStart);
                            console.log(`✅ Successfully initiated start for instances: ${instanceIdsStart.join(", ")}`);

                            // ✅ Send a message back to the Webview to update the UI
                            this.postMessage(webviewId, { 
                                type: "startedResources", 
                                startedInstances: instanceIdsStart, 
                                userId: userIdAWSstart
                            });

                        } catch (error) {
                            console.error(`❌ Error starting instances for user ${userIdAWSstart}:`, error);
                            window.showErrorMessage(`Error starting instances: ${error}`);
                        }
                        break;
                    case "createGroup":
                        console.log(`🔹 Received createGroup request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in createGroup request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        // ✅ Retrieve user session based on provider
                        const userIdCreateGroup = userSession[provider];

                        if (!userIdCreateGroup) {
                            console.error(`❌ No authenticated ${provider.toUpperCase()} user found. Please authenticate first.`);
                            window.showErrorMessage(`Please authenticate with ${provider.toUpperCase()} first!`);
                            return;
                        }

                        // ✅ Validate required parameters
                        if (!payload || !Array.isArray(payload.instanceIds) || payload.instanceIds.length === 0) {
                            console.warn("❌ Invalid group creation request: Missing instance IDs.");
                            window.showErrorMessage("Missing instances for group creation.");
                            return;
                        }

                        const { instanceIds: instancesNewGroup } = payload;

                        console.log(`📤 Creating ${provider.toUpperCase()} Group for userId: ${userIdCreateGroup}`, instancesNewGroup);
                        window.showInformationMessage(`Creating ${provider.toUpperCase()} Group with ${instancesNewGroup.length} instance(s).`);

                        try {
                            // ✅ Call the general `createGroup` function in CloudManager
                            const groupname = await this.cloudManager.createGroup(provider, userIdCreateGroup, instancesNewGroup);

                            if (!groupname) {
                                return;
                            }
                            console.log(`✅ Successfully created ${provider.toUpperCase()} group.`);

                            // ✅ Notify the webview about the created group
                            this.postMessage(webviewId, {
                                type: "groupCreated",
                                provider,
                                groupname,
                                instances: instancesNewGroup,
                                userId: userIdCreateGroup
                            });

                        } catch (error) {
                            console.error(`❌ Error creating group for ${provider.toUpperCase()} user ${userIdCreateGroup}:`, error);
                            window.showErrorMessage(`Error creating group: ${error}`);
                        }
                        break;
                    case "addToGroup":
                        console.log(`🔹 Received addToGroup request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in addToGroup request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        const userIdAddGroup = userSession[provider];

                        if (!userIdAddGroup) {
                            console.error(`❌ No authenticated ${provider.toUpperCase()} user found. Please authenticate first.`);
                            window.showErrorMessage(`Please authenticate with ${provider.toUpperCase()} first!`);
                            return;
                        }

                        if (!payload || !Array.isArray(payload.instanceIds) || payload.instanceIds.length === 0) {
                            console.warn("❌ Invalid add request: Missing instance IDs.");
                            window.showErrorMessage("Missing instances for adding to group.");
                            return;
                        }

                        const { instanceIds: instancesToAdd } = payload;

                        console.log(`📤 Adding instances to ${provider.toUpperCase()} Group for userId: ${userIdAddGroup}`, instancesToAdd);
                        window.showInformationMessage(`Adding ${instancesToAdd.length} instance(s) to a group.`);

                        try {
                            // ✅ Call the general `addInstancesToGroup` function in CloudManager
                            const groupname = await this.cloudManager.addInstancesToGroup(provider, userIdAddGroup, instancesToAdd);

                            if (!groupname) {
                                return;
                            }
                            console.log(`✅ Successfully added instances to group: ${instancesToAdd.join(", ")}`);

                            // ✅ Send message back to Webview to update UI
                            this.postMessage(webviewId, {
                                type: "groupCreated",
                                provider,
                                groupname,
                                instances: instancesToAdd,
                                userId: userIdAddGroup
                            });
                        } catch (error) {
                            console.error(`❌ Error adding instances to group for user ${userIdAddGroup}:`, error);
                            window.showErrorMessage(`Error adding instances: ${error}`);
                        }
                        break;
                    case "removeFromGroup":
                        if (!webviewId) {
                            console.error("❌ Missing webviewId in removeFromGroup request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        const userIdRemoveGroup = userSession[provider];

                        if (!userIdRemoveGroup) {
                            console.error(`❌ No authenticated ${provider.toUpperCase()} user found. Please authenticate first.`);
                            window.showErrorMessage(`Please authenticate with ${provider.toUpperCase()} first!`);
                            return;
                        }

                        if (!payload || !Array.isArray(payload.instanceIds) || payload.instanceIds.length === 0) {
                            console.warn("❌ Invalid remove request: Missing instance IDs.");
                            window.showErrorMessage("Missing instances for removal from group.");
                            return;
                        }

                        const { instanceIds: instancesToRemove } = payload;

                        window.showInformationMessage(`Removing ${instancesToRemove.length} instance(s) from a group.`);

                        try {
                            // ✅ Call the general `removeInstancesFromGroup` function in CloudManager
                            const groupname = await this.cloudManager.removeInstancesFromGroup(provider, userIdRemoveGroup, instancesToRemove);

                            if (!groupname) {
                                return;
                            }
                            console.log(`✅ Successfully removed instances from group: ${instancesToRemove.join(", ")}`);

                            // ✅ Send message back to Webview to update UI
                            this.postMessage(webviewId, {
                                type: "groupCreated",
                                provider,
                                groupname,
                                instances: instancesToRemove,
                                userId: userIdRemoveGroup
                            });
                        } catch (error) {
                            console.error(`❌ Error removing instances from group for user ${userIdRemoveGroup}:`, error);
                            window.showErrorMessage(`Error removing instances: ${error}`);
                        }
                        break;
                    case "setGroupDowntime":
                        console.log(`🔹 Received setGroupDowntime request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in setGroupDowntime request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        // ✅ Retrieve user session based on provider
                        const userIdSetDowntime = userSession[provider];

                        if (!userIdSetDowntime) {
                            console.error(`❌ No authenticated ${provider.toUpperCase()} user found. Please authenticate first.`);
                            window.showErrorMessage(`Please authenticate with ${provider.toUpperCase()} first!`);
                            return;
                        }

                        // ✅ Validate required parameters
                        if (!payload || !payload.groupName) {
                            console.warn("❌ Invalid downtime request: Missing group name.");
                            window.showErrorMessage("Missing required details for setting group downtime.");
                            return;
                        }

                        const { groupName } = payload;

                        console.log(`📤 Setting downtime for ${provider.toUpperCase()} group '${groupName}'.`);
                        window.showInformationMessage(`Setting downtime for group '${groupName}'.`);

                        try {
                            // ✅ Call the general `setGroupDowntime` function in CloudManager
                            const time = await this.cloudManager.setGroupDowntime(provider, userIdSetDowntime, groupName);

                            console.log(`✅ Successfully set downtime for ${provider.toUpperCase()} group '${groupName}'.`);

                            // ✅ Notify the webview about the updated downtime
                            this.postMessage(webviewId, {
                                type: "groupDowntimeSet",
                                provider,
                                time, 
                                groupName,
                                userId: userIdSetDowntime
                            });
                        } catch (error) {
                            console.error(`❌ Error setting downtime for group '${groupName}' for ${provider.toUpperCase()} user ${userIdSetDowntime}:`, error);
                            window.showErrorMessage(`Error setting group downtime: ${error}`);
                        }
                        break;
                    case "deleteGroupDowntime":
                        console.log(`🔹 Received deleteGroupDowntime request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in deleteGroupDowntime request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        // ✅ Retrieve user session based on provider
                        const userIdDeleteDowntime = userSession[provider];

                        if (!userIdDeleteDowntime) {
                            console.error(`❌ No authenticated ${provider.toUpperCase()} user found. Please authenticate first.`);
                            window.showErrorMessage(`Please authenticate with ${provider.toUpperCase()} first!`);
                            return;
                        }

                        // ✅ Validate required parameters
                        if (!payload || !payload.groupName) {
                            console.warn("❌ Invalid downtime delete request: Missing group name.");
                            window.showErrorMessage("Missing required details for deleting group downtime.");
                            return;
                        }

                        const groupNameDel = payload.groupName;

                        console.log(`📤 Deleting downtime for ${provider.toUpperCase()} group '${groupNameDel}'.`);
                        window.showInformationMessage(`Deleting downtime for group '${groupNameDel}'.`);

                        try {
                            // ✅ Call the general `removeGroupDowntime` function in CloudManager
                            const success = await this.cloudManager.removeGroupDowntime(groupNameDel);

                            if (!success) {
                                console.warn(`⚠️ No downtime found for group '${groupNameDel}', or deletion failed.`);
                                window.showErrorMessage(`No downtime found for group '${groupNameDel}', or deletion failed.`);
                                return;
                            }

                            console.log(`✅ Successfully removed downtime for ${provider.toUpperCase()} group '${groupNameDel}'.`);

                            // ✅ Notify the webview about the deleted downtime
                            this.postMessage(webviewId, {
                                type: "groupDowntimeDeleted",
                                provider,
                                groupNameDel,
                                userId: userIdDeleteDowntime
                            });

                        } catch (error) {
                            console.error(`❌ Error deleting downtime for group '${groupNameDel}' for ${provider.toUpperCase()} user ${userIdDeleteDowntime}:`, error);
                            window.showErrorMessage(`Error deleting group downtime: ${error}`);
                        }
                        break;
                }
            } catch (error) {
                console.error(`❌ Error handling message ${type} for ${provider}:`, error);
                window.showErrorMessage(`Error: ${error}`);
            }
        });
    }

    private postMessage(webviewId: string, message: any) {
        const userView = this.viewInstances.get(webviewId);
        
        if (userView) {
            console.log(`📤 Sending message to WebView for webviewId ${webviewId}:`, message);
            userView.webview.postMessage(message);
        } else {
            console.warn(`⚠️ No WebView found for webviewId ${webviewId}. Cannot send message.`);
        }
    }    

    private getHtmlContent(fileName: string): string {
        const filePath = path.join(this._extensionUri.fsPath, 'media', 'html', fileName);
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            console.error(`Error reading file ${fileName}: ${error}`);
            return '<p>Error loading content</p>';
        }
    }

    private getHtmlForWebview(connectHtml: string, awsHtml: string, azureHtml: string, multiHtml: string): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
           <meta charset="UTF-8">
           <title>Cloud Instance Manager</title>
           <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
           <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
           <style>
               body {
                   font-family: Arial, sans-serif;
                   background-color: #1e1e1e;
                   color: #eaeaea;
                   margin: 0;
                   padding: 0;
               }
               .container {
                   max-width: 800px;
                   width: 100%;
                   padding-top: 20px;
                   padding-left: 10px;
                   padding-right: 10px;
                   margin: 0 auto;
               }
               .title {
                   font-size: 24px;
                   font-weight: bold;
                   color: #66aaff;
                   margin-bottom: 20px;
                   text-align: center;
               }
               .nav-tabs {
                   background-color: #333;
                   border-radius: 5px;
                   margin-bottom: 20px;
                   display: flex;
                   justify-content: flex-start;
                   overflow: hidden;
               }
               .nav-item {
                   flex: 1;
               }
               .nav-item .nav-link {
                   color: #ccc;
                   padding: 8px 16px;
                   font-size: 14px;
                   text-align: center;
                   border: none;
                   width: 100%;
                   transition: background-color 0.3s;
               }
               .nav-item .nav-link.active {
                   background-color: #66aaff;
                   color: #333;
               }
               .nav-link:hover {
                   background-color: #575757;
               }
               .tab-content {
                   background-color: #222;
                   padding: 20px;
                   border-radius: 5px;
               }
               .tab-content h4 {
                   color: #66aaff;
                   margin-top: 0;
               }
               .page-content {
                   background-color: #222;
                   padding: 20px;
                   border-radius: 5px;
                   margin-top: 10px;
               }
           </style>
           <script>
                const vscode = acquireVsCodeApi();
                let webviewId = null;

                window.addEventListener("DOMContentLoaded", () => {
                    document.getElementById("connectAWS").addEventListener("click", function() {
                        const awsStatusElement = document.getElementById("awsStatus");
                        awsStatusElement.textContent = "AWS Status: Connecting...";
                        awsStatusElement.className = "status-text connecting";

                        vscode.postMessage({
                            type: "connect",
                            provider: "aws",
                            webviewId
                        });
                    });

                    document.getElementById("connectAzure").addEventListener("click", function() {
                        const azureStatusElement = document.getElementById("azureStatus");
                        azureStatusElement.textContent = "Azure Status: Connecting...";
                        azureStatusElement.className = "status-text connecting";

                        vscode.postMessage({
                            type: "connect",
                            provider: "azure",
                            webviewId
                        });
                    });

                    document.getElementById("subscription").addEventListener("change", function () {
                        const selectedSubscriptionId = document.getElementById("subscription").value;
                        console.log("🔹 Subscription changed to:", selectedSubscriptionId);

                        if (selectedSubscriptionId) {
                            // ✅ Request resource groups for the selected subscription
                            vscode.postMessage({
                                type: "getResourceGroups",
                                provider: "azure",
                                webviewId,
                                payload: { subscriptionId: selectedSubscriptionId }
                            });

                            // Show "Fetching..." in dropdown while waiting for response
                            const resourceGroupDropdown = document.getElementById("resourceGroup");
                            resourceGroupDropdown.innerHTML = "<option value=''>Fetching resource groups...</option>";
                        }
                    });

                    window.addEventListener("message", event => {
                        console.log("🔹 Received message from extension:", event.data);
                        const message = event.data;

                        if (message.type === "webviewInitialized") {
                            webviewId = message.webviewId;
                            console.log("✅ Webview initialized with ID:", webviewId);
                        }

                        if (message.type === "awsConnected") {
                            document.getElementById("awsStatus").textContent = "AWS Status: Connected";
                            document.getElementById("awsStatus").className = "status-text connected";
                            document.getElementById("status-aws").textContent = "AWS Status: Connected";
                            document.getElementById("status-aws").className = "status-text connected";
                        }

                        if (message.type === "azureConnected") {
                            document.getElementById("azureStatus").textContent = "Azure Status: Connected";
                            document.getElementById("azureStatus").className = "status-text connected";
                            document.getElementById("status-azure").textContent = "Azure Status: Connected";
                            document.getElementById("status-azure").className = "status-text connected";
                        }

                        if (message.type === "updateKeyPairs") {
                            console.log("✅ Received key pairs:", message.keyPairs);
                    
                            const keyPairSelect = document.getElementById("keyPair");
                            keyPairSelect.innerHTML = ""; // Clear previous options
                    
                            if (!message.keyPairs || message.keyPairs.length === 0) {
                                console.warn("⚠️ No key pairs received.");
                                keyPairSelect.innerHTML = "<option value=''>No key pairs available</option>";
                            } else {
                                message.keyPairs.forEach((kp) => {
                                    const option = document.createElement("option");
                                    option.value = kp;
                                    option.textContent = kp;
                                    keyPairSelect.appendChild(option);
                                });
                    
                                // ✅ Select the first available key pair automatically
                                keyPairSelect.value = message.keyPairs[0];
                            }
                        }
                        if (message.type === "updateInstances") {
                            console.log("✅ Received instances:", message.instances);

                            const tableBody = document.querySelector("#instancesTable tbody");
                            tableBody.innerHTML = ""; // Clear existing rows

                            if (!message.instances || message.instances.length === 0) {
                                console.warn("⚠️ No instances received.");
                                tableBody.innerHTML = "<tr><td colspan='6'>No instances found.</td></tr>";
                                return;
                            }

                            message.instances.forEach(instance => {
                                const row = document.createElement("tr");

                                // Get group name and shutdown schedule
                                const groupName = instance.groupName ? instance.groupName : "N/A";
                                let shutdownSchedule = instance.shutdownSchedule;
    
                                // Ensure that if it's "N/A | N/A", it just shows "N/A"
                                if (!shutdownSchedule || shutdownSchedule === "N/A" || shutdownSchedule.trim() === "N/A | N/A") {
                                    shutdownSchedule = "N/A";
                                }

                                row.innerHTML = \`
                                    <td><input type="checkbox" /></td>
                                    <td style="display: none;">\${instance.instanceId}</td>
                                    <td>\${instance.instanceName || "N/A"}</td>
                                    <td>\${instance.state}</td>
                                    <td>\${instance.region}</td>
                                    <td>\${groupName}</td>
                                    <td>\${shutdownSchedule}</td>
                                \`;
                                tableBody.appendChild(row);
                            });
                        }
                        if (message.type === "updateVMs") {
                            console.log("✅ Received VMs:", message.VMs);

                            const tableBody = document.querySelector("#vmsTable tbody");
                            tableBody.innerHTML = ""; // Clear existing rows

                            if (!message.VMs || message.VMs.length === 0) {
                                console.warn("⚠️ No VMs received.");
                                tableBody.innerHTML = "<tr><td colspan='7' style='text-align:center; color: gray;'>No active VMs found.</td></tr>";
                                return;
                            }

                            message.VMs.forEach(vm => {
                                const row = document.createElement("tr");

                                // Placeholder values for Group and Shutdown Schedule (modify as needed)
                                const groupName = vm.groupName ? vm.groupName : "N/A";
                                let shutdownSchedule = vm.shutdownSchedule || "N/A";

                                // Ensure that if it's "N/A | N/A", it just shows "N/A"
                                if (shutdownSchedule.trim() === "N/A | N/A") {
                                    shutdownSchedule = "N/A";
                                }

                                row.innerHTML = \`
                                    <td><input type="checkbox" /></td>
                                    <td style="display: none;">\${vm.id}</td>
                                    <td>\${vm.name || "N/A"}</td>
                                    <td>\${vm.status}</td>
                                    <td>\${vm.region}</td>
                                    <td>"N/A"</td>
                                    <td>"N/A"</td>
                                    <td style="display: none;">\${vm.subscriptionId}</td>
                                \`;

                                tableBody.appendChild(row);
                            });
                        }

                        if (message.type === "instanceCreated") {
                            let instanceId = message.instanceId || "Unknown ID";
                            let instanceName = message.instanceName || "N/A";
                            const region = message.region;

                            const table = document.getElementById("instancesTable").getElementsByTagName('tbody')[0];

                            // Remove initial waiting row if it's present
                            const initialRow = document.getElementById("initialRow");
                            if (initialRow) {
                                initialRow.remove();
                            }

                            // Create a new row
                            const newRow = table.insertRow();

                            // Checkbox column
                            const selectCell = newRow.insertCell(0);
                            const checkbox = document.createElement("input");
                            checkbox.type = "checkbox";
                            selectCell.appendChild(checkbox);
                            selectCell.classList.add("checkbox-column");

                            // Instance ID column
                            const idCell = newRow.insertCell(1);
                            idCell.textContent = instanceId;
                            idCell.style.display = "none";

                            // Name column
                            const name = newRow.insertCell(2);
                            name.textContent = instanceName;

                            // Status column
                            const statusCell = newRow.insertCell(3);
                            statusCell.textContent = "running";
                            statusCell.classList.add("status-column");

                            // Region
                            const regionCell = newRow.insertCell(4);
                            regionCell.textContent = region;

                            // Group column
                            const groupCell = newRow.insertCell(5);
                            groupCell.textContent = "N/A";

                            // Shutdown Schedule column
                            const shutdownCell = newRow.insertCell(6);
                            shutdownCell.textContent = "N/A";
                        }
                        if (message.type === "groupDowntimeDeleted") {
                            console.log("✅ Downtime deleted for group:", message.groupNameDel);

                            const { groupNameDel } = message;

                            // ✅ Update the shutdown schedule in the instances table
                            const rows = document.querySelectorAll("#instancesTable tbody tr");

                            rows.forEach(row => {
                                const groupNameCell = row.cells[5]; // Assuming group name is in the 4th column
                                const shutdownCell = row.cells[6]; // Assuming shutdown schedule is in the 5th column

                                if (groupNameCell && groupNameCell.textContent.trim() === groupNameDel) {
                                    shutdownCell.textContent = "N/A"; // ✅ Reset to N/A
                                }
                            });
                        }
                        if (message.type === "updateSubscriptions") {
                            console.log("✅ Received subscriptions:", message.subscriptions);
                            updateSubscriptionDropdown(message.subscriptions);
                        }    
                        if (message.type === "updateResourceGroups") {
                            console.log("📂 Received resource groups:", message.resourceGroups);
                            updateResourceGroupDropdown(message.resourceGroups);
                        }
                        if (message.type === "stoppedResources") {
                            const stoppedInstances = message.stoppedInstances;
                            console.log("🔹 Updating UI for stopped instances:", stoppedInstances);

                            stoppedInstances.forEach(instanceId => {
                                const rows = document.querySelectorAll("#instancesTable tbody tr");
                                rows.forEach(row => {
                                    const idCell = row.cells[1]; // Instance ID column
                                    if (idCell && idCell.textContent.trim() === instanceId) {
                                        const statusCell = row.cells[3]; // Status column
                                        statusCell.textContent = "stopping"; // ✅ Update status
                                    }
                                });
                            });
                        }
                        if (message.type === "terminatedResources") {
                            const terminatedInstances = message.terminatedInstances;
                            console.log("🛑 Updating status for terminated instances:", terminatedInstances);

                            terminatedInstances.forEach(instanceId => {
                                const rows = document.querySelectorAll("#instancesTable tbody tr");
                                rows.forEach(row => {
                                    const idCell = row.cells[1]; // Instance ID column
                                    if (idCell && idCell.textContent.trim() === instanceId) {
                                        const statusCell = row.cells[3]; // Status column
                                        statusCell.textContent = "terminated"; // ✅ Set status
                                    }
                                });
                            });
                        }
                        if (message.type === "startedResources") {
                            const startedInstances = message.startedInstances;
                            console.log("🚀 Updating status for started instances:", startedInstances);

                            startedInstances.forEach(instanceId => {
                                const rows = document.querySelectorAll("#instancesTable tbody tr");
                                rows.forEach(row => {
                                    const idCell = row.cells[1]; // Instance ID column
                                    if (idCell && idCell.textContent.trim() === instanceId) {
                                        const statusCell = row.cells[3]; // Status column
                                        statusCell.textContent = "running"; // ✅ Update status
                                    }
                                });
                            });
                        }
                        if (message.type === "groupCreated") {
                            const { provider, groupname, instances, userId } = message;

                            instances.forEach(instanceId => {
                                const rows = document.querySelectorAll("#instancesTable tbody tr");
                                rows.forEach(row => {
                                    const idCell = row.cells[1]; // Instance ID column
                                    if (idCell && idCell.textContent.trim() === instanceId) {
                                        const groupNameCell = row.cells[5]; // Assuming group name is in the 4th column
                                        groupNameCell.textContent = groupname; // ✅ Update group name
                                    }
                                });
                            });
                        }
                        if (message.type === "updateGroupsAWS") {
                            console.log("✅ Received AWS user groups:", message.awsGroups);

                            const groupSelect = document.getElementById("groupNameAws");
                            groupSelect.innerHTML = ""; // Clear previous options

                            if (!message.awsGroups || message.awsGroups.length === 0) {
                                console.warn("⚠️ No AWS groups found.");
                                groupSelect.innerHTML = "<option value=''>No groups found</option>";
                            } else {
                                message.awsGroups.forEach((group) => {
                                    const option = document.createElement("option");
                                    option.value = group;
                                    option.textContent = group;
                                    groupSelect.appendChild(option);
                                });

                                // ✅ Select the first available group automatically
                                groupSelect.value = message.awsGroups[0];
                            }
                        }
                        if (message.type === "groupDowntimeSet") {
                            const { provider, time, groupName, userId } = message; 

                            console.log("✅ Reached message downtime set:", message);

                            // ✅ Update the shutdown schedule in the instances table
                            const rows = document.querySelectorAll("#instancesTable tbody tr");
                            rows.forEach(row => {
                                const groupNameCell = row.cells[5]; 
                                const shutdownCell = row.cells[6]; 

                                if (groupNameCell && groupNameCell.textContent.trim() === groupName) {
                                    console.log("🔹 Start Time:", time.startTime, " | End Time:", time.endTime); // ✅ Debug log
                                    shutdownCell.textContent = String(time.startTime) + " | " + String(time.endTime);
                                }
                            });
                        }
                        if (message.type === "updateCosts") {
                            const { provider, cost, userId } = message;

                            document.getElementById("awsCost").textContent = "Month Cost: $" + cost;
                        }
                    });

                    document.getElementById("region-aws").addEventListener("change", function () {
                        const region = document.getElementById("region-aws").value;
                        console.log("🔹 Region changed to:", region);
                
                        // Show "Fetching..." while waiting for the response
                        const keyPairSelect = document.getElementById("keyPair");
                        keyPairSelect.innerHTML = "<option value=''>Fetching key pairs...</option>";
                
                        vscode.postMessage({
                            type: "changeRegion",
                            provider: "aws",
                            webviewId,  // ✅ Sending webviewId to backend
                            payload: { region }
                        });
                    });

                    document.getElementById("createInstance").addEventListener("click", () => {
                        const keyPair = document.getElementById("keyPair").value;
                        const region = document.getElementById("region-aws").value;

                        if (!keyPair) {
                            alert("Please select a key pair before creating an instance.");
                            return;
                        }
                        
                        // Send message to extension to create an AWS instance
                        vscode.postMessage({ 
                            type: "createInstance", 
                            provider: "aws",
                            webviewId, 
                            payload: { region, keyPair }
                        });
                    });

                    document.getElementById("createVM").addEventListener("click", () => {
                        const subscriptionId = document.getElementById("subscription").value;
                        const resourceGroup = document.getElementById("resourceGroup").value;
                        const region = document.getElementById("region-azure").value;
                        const sshKey = document.getElementById("sshKey").value.trim();

                        if (!subscriptionId) {
                            alert("Please select an Azure subscription.");
                            return;
                        }

                        if (!resourceGroup) {
                            alert("Please select a resource group.");
                            return;
                        }

                        if (!region) {
                            alert("Please select a region.");
                            return;
                        }

                        if (!sshKey) {
                            alert("Please provide an SSH public key.");
                            return;
                        }

                        // Send message to extension to create an Azure VM
                        vscode.postMessage({
                            type: "createInstance",
                            provider: "azure",
                            webviewId,
                            payload: {
                                subscriptionId,
                                resourceGroup,
                                region,
                                sshKey
                            }
                        });
                    });

                    document.getElementById("refreshaws").addEventListener("click", () => {
                        console.log("🔄 Refresh AWS Instances button clicked");

                        // ✅ Send a message to VS Code extension
                        vscode.postMessage({
                            type: "refreshawsinstances",
                            webviewId
                        });

                        console.log("📤 Sent refreshawsinstances message");
                    });

                    document.getElementById("submitInstanceAction").addEventListener("click", () => {
                        const selectedInstances = [];
                        console.log("🔹 Instance action requested...");

                        // Get the selected action from the dropdown
                        const selectedAction = document.getElementById("instanceAction").value;

                        // Get all checked checkboxes in the table
                        const checkboxes = document.querySelectorAll("#instancesTable tbody input[type='checkbox']:checked");

                        checkboxes.forEach(checkbox => {
                            const row = checkbox.closest("tr"); // Find the row containing this checkbox
                            const instanceId = row.cells[1].textContent.trim(); // Extract the Instance ID from the second column
                            if (instanceId) {
                                selectedInstances.push(instanceId);
                            }
                        });

                        // Ensure at least one instance is selected
                        if (selectedInstances.length === 0) {
                            alert("No instances selected.");
                            return;
                        }

                        let messageType = "";
                        let actionMessage = "";

                        switch (selectedAction) {
                            case "startaws":
                                messageType = "startInstances";
                                actionMessage = "Starting AWS Instances";
                                break;
                            case "stopaws":
                                messageType = "shutdownInstances";
                                actionMessage = "Shutting down AWS Instances";
                                break;
                            case "terminateaws":
                                messageType = "terminateInstances";
                                actionMessage = "Terminating AWS Instances";
                                break;
                            default:
                                alert("Invalid action selected.");
                                return;
                        }
                        console.log("Sending Message from slected action", messageType);
                        // ✅ Send message to VS Code extension
                        vscode.postMessage({
                            type: messageType,
                            provider: "aws",
                            webviewId,
                            payload: { instanceIds: selectedInstances }
                        });
                    });

                    document.getElementById("submitInstanceActionAzure").addEventListener("click", () => {
                        const selectedVMs = [];
                        console.log("🔹 Azure VM action requested...");

                        // Get the selected action from the dropdown
                        const selectedAction = document.getElementById("instanceActionAzure").value;

                        // Get all checked checkboxes in the VM table
                        const checkboxes = document.querySelectorAll("#vmsTable tbody input[type='checkbox']:checked");

                        checkboxes.forEach(checkbox => {
                            const row = checkbox.closest("tr"); // Find the row containing this checkbox
                            const vmId = row.cells[1].textContent.trim(); // Extract the VM ID from the second column
                            const subscriptionId = row.cells[7].textContent.trim(); // Extract Subscription ID from the hidden column

                            if (vmId && subscriptionId) {
                                selectedVMs.push({ vmId, subscriptionId });
                            }
                        });

                        // Ensure at least one VM is selected
                        if (selectedVMs.length === 0) {
                            alert("⚠️ No VMs selected.");
                            return;
                        }

                        let messageType = "";
                        let actionMessage = "";

                        switch (selectedAction) {
                            case "startazure":
                                messageType = "startVMs";
                                actionMessage = "Starting Azure VMs...";
                                break;
                            case "stopazure":
                                messageType = "stopVMs";
                                actionMessage = "Stopping Azure VMs...";
                                break;
                            case "terminateazure":
                                messageType = "terminateVMs";
                                actionMessage = "Terminating Azure VMs...";
                                break;
                            default:
                                alert("❌ Invalid action selected.");
                                return;
                        }

                        // ✅ Send message to VS Code extension
                        vscode.postMessage({
                            type: messageType,
                            provider: "azure",
                            webviewId,
                            payload: { vms: selectedVMs } // Now sending an array of { vmId, subscriptionId }
                        });
                    });



                    document.getElementById("submitGroupAction").addEventListener("click", () => {
                        const selectedInstances = [];
                        console.log("🔹 Group action requested...");

                        // Get the selected action from the dropdown
                        const selectedAction = document.getElementById("groupAction").value;

                        // Get all checked checkboxes in the table
                        const checkboxes = document.querySelectorAll("#instancesTable tbody input[type='checkbox']:checked");

                        checkboxes.forEach(checkbox => {
                            const row = checkbox.closest("tr"); // Find the row containing this checkbox
                            const instanceId = row.cells[1].textContent.trim(); // Extract the Instance ID from the second column
                            if (instanceId) {
                                selectedInstances.push(instanceId);
                            }
                        });

                        // Ensure at least one instance is selected
                        if (selectedInstances.length === 0) {
                            alert("No instances selected.");
                            return;
                        }

                        let messageType = "";
                        let actionMessage = "";

                        switch (selectedAction) {
                            case "createaws":
                                messageType = "createGroup";
                                actionMessage = "Creating AWS Group";
                                break;
                            case "addaws":
                                messageType = "addToGroup";
                                actionMessage = "Adding Instances to AWS Group";
                                break;
                            case "removeaws":
                                messageType = "removeFromGroup";
                                actionMessage = "Removing Instances from AWS Group";
                                break;
                            case "downtimeaws":
                                messageType = "scheduleDowntime";
                                actionMessage = "Scheduling Downtime for AWS Group";
                                break;
                            default:
                                alert("Invalid action selected.");
                                return;
                        }
                        
                        // ✅ Send message to VS Code extension
                        vscode.postMessage({
                            type: messageType,
                            provider: "aws",
                            webviewId,
                            payload: { instanceIds: selectedInstances }
                        });
                    });
                    document.getElementById("submitDownAction").addEventListener("click", () => {
                        console.log("🔹 Downtime action requested...");

                        // Get the selected group from the dropdown
                        const selectedGroup = document.getElementById("groupNameAws").value;
                        if (!selectedGroup) {
                            alert("No group selected.");
                            return;
                        }

                        // Get the selected action from the action dropdown
                        const selectedAction = document.getElementById("groupSelect").value;
                        let messageType = "";
                        let actionMessage = "";

                        switch (selectedAction) {
                            case "setdownaws":
                                messageType = "setGroupDowntime";
                                break;
                            case "viewdownaws":
                                messageType = "viewGroupDowntime";
                                break;
                            case "deldownaws":
                                messageType = "deleteGroupDowntime";
                                break;
                            default:
                                alert("Invalid action selected.");
                                return;
                        }

                        // ✅ Send message to VS Code extension
                        vscode.postMessage({
                            type: messageType,
                            provider: "aws",
                            webviewId,
                            payload: { groupName: selectedGroup }
                        });
                    });

                });

                function updateSubscriptionDropdown(subscriptions) {
                    const subscriptionDropdown = document.getElementById("subscription");

                    // Clear existing options
                    subscriptionDropdown.innerHTML = "";

                    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
                        const noSubsOption = document.createElement("option");
                        noSubsOption.value = "";
                        noSubsOption.textContent = "No active subscriptions found";
                        subscriptionDropdown.appendChild(noSubsOption);
                        return;
                    }

                    // Populate the dropdown with subscription options
                    subscriptions.forEach(sub => {
                        if (sub.subscriptionId && sub.displayName) {
                            const option = document.createElement("option");
                            option.value = sub.subscriptionId;
                            option.textContent = sub.displayName;
                            subscriptionDropdown.appendChild(option);
                        }
                    });
                }
                function updateResourceGroupDropdown(resourceGroups) {
                    console.log("📂 Received resourceGroups:", JSON.stringify(resourceGroups, null, 2));

                    const resourceGroupDropdown = document.getElementById("resourceGroup");

                    // Clear existing options
                    resourceGroupDropdown.innerHTML = "";

                    const selectedSubscriptionId = document.getElementById("subscription").value;
                    console.log("🔹 Selected Subscription ID:", selectedSubscriptionId);

                    if (!selectedSubscriptionId || !resourceGroups[selectedSubscriptionId]) {
                        console.warn("⚠️ No resource groups found for Subscription ID");
                        const noGroupsOption = document.createElement("option");
                        noGroupsOption.value = "";
                        noGroupsOption.textContent = "No resource groups available";
                        resourceGroupDropdown.appendChild(noGroupsOption);
                        return;
                    }

                    const groupsForSubscription = resourceGroups[selectedSubscriptionId];

                    if (!Array.isArray(groupsForSubscription) || groupsForSubscription.length === 0) {
                        console.warn("⚠️ No resource groups found for this subscription.");
                        const noGroupsOption = document.createElement("option");
                        noGroupsOption.value = "";
                        noGroupsOption.textContent = "No resource groups available";
                        resourceGroupDropdown.appendChild(noGroupsOption);
                        return;
                    }

                    console.log("✅ Populating resource groups:", groupsForSubscription);

                    // Populate dropdown with resource groups
                    groupsForSubscription.forEach(function (rg) {
                        if (rg && rg.resourceGroupName) {
                            const option = document.createElement("option");
                            option.value = rg.resourceGroupName;
                            option.textContent = rg.resourceGroupName;
                            resourceGroupDropdown.appendChild(option);
                        }
                    });

                    // ✅ Auto-select the first available resource group
                    resourceGroupDropdown.value = groupsForSubscription[0]?.resourceGroupName || "";
                }
            </script>
       </head>
        <body>
            <div class="container">
                <div class="title">
                    Cloud Instance Manager
                </div>
                <ul class="nav nav-tabs" id="myTab" role="tablist">
                    <li class="nav-item" role="presentation">
                        <a class="nav-link active" id="connect-tab" data-bs-toggle="tab" href="#connect" role="tab" aria-controls="connect" aria-selected="true">Connect</a>
                    </li>
                    <li class="nav-item" role="presentation">
                        <a class="nav-link" id="aws-tab" data-bs-toggle="tab" href="#aws" role="tab" aria-controls="aws" aria-selected="false">AWS</a>
                    </li>
                    <li class="nav-item" role="presentation">
                        <a class="nav-link" id="azure-tab" data-bs-toggle="tab" href="#azure" role="tab" aria-controls="azure" aria-selected="false">Azure</a>
                    </li>
                    <li class="nav-item" role="presentation">
                        <a class="nav-link" id="multi-tab" data-bs-toggle="tab" href="#multi" role="tab" aria-controls="multi" aria-selected="false">Multi</a>
                    </li>
                </ul>
                <div class="tab-content" id="myTabContent">
                    <div class="tab-pane fade show active" id="connect" role="tabpanel" aria-labelledby="connect-tab">
                        ${connectHtml}
                    </div>
                    <div class="tab-pane fade" id="aws" role="tabpanel" aria-labelledby="aws-tab">
                        ${awsHtml}
                    </div>
                    <div class="tab-pane fade" id="azure" role="tabpanel" aria-labelledby="azure-tab">
                        ${azureHtml}
                    </div>
                    <div class="tab-pane fade" id="multi" role="tabpanel" aria-labelledby="multi-tab">
                        ${multiHtml}
                    </div>
                </div>
            </div>
        </body>
        </html>`;
    }
}