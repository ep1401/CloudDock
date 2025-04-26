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
    private userSessions: Map<string, Record<string, string>> = new Map(); 

    constructor(private readonly _extensionUri: Uri, public extensionContext: ExtensionContext) {
        this.scheduler = scheduler;
    }

    resolveWebviewView(webviewView: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken) {
        // Assign a unique ID to this webview
        const webviewId = uuidv4();

        (webviewView as any)._myWebviewId = webviewId;

        this.viewInstances.set(webviewId, webviewView);
        this.userSessions.set(webviewId, {});


        this.viewInstances.clear();
        this.userSessions.clear();
                
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
            const { provider, type, payload } = data;
            const webviewId = (webviewView as any)._myWebviewId;

            const userSession = this.userSessions.get(webviewId) || {}; 
            let userId = userSession[provider];

            try {
                switch (type) {
                    case "connect":
                        try {
                            const result = await this.cloudManager.connect(provider);

                            if (typeof result === "string") {
                                userId = result;
                            } else if (result && typeof result === "object" && "userAccountId" in result) {
                                userId = result.userAccountId;

                                if (typeof userId === "string" && userId.trim().length > 0) {
                                    // ✅ Store userId for this webview
                                    userSession[provider] = userId;
                                    this.userSessions.set(webviewId, userSession);

                                    // ✅ Send messages to update UI
                                    this.postMessage(webviewId, { type: `${provider}Connected`, userId });

                                    if (provider === "aws") {
                                        if ("keyPairs" in result) {
                                            const { keyPairs } = result;
                                            this.postMessage(webviewId, { type: "updateKeyPairs", keyPairs, userId });
                                        }
                                        if ("ec2instances" in result) {
                                            const { ec2instances } = result;
                                            this.postMessage(webviewId, { type: "updateInstances", instances: ec2instances, userId });
                                        }
                                        if ("usergroups" in result) {
                                            const { usergroups } = result;
                                            const { awsGroups } = usergroups;
                                            console.log("awsgroup:", awsGroups);
                                            this.postMessage(webviewId, { type: "updateGroupsAWS", awsGroups, userId });
                                        }
                                        if ("cost" in result) {
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
                                        if ("cost" in result) {
                                            const { cost } = result;
                                            this.postMessage(webviewId, { type: "updateCostsAzure", provider, cost, userId });
                                        }
                                        if ("usergroups" in result) {
                                            const { usergroups } = result;
                                            const { azureGroups } = usergroups;
                                            console.log("azuregroup:", azureGroups);
                                            this.postMessage(webviewId, { type: "updateGroupsAzure", azureGroups, userId });
                                        }
                                    }

                                    // ✅ Check if the *other* provider is already connected
                                    const otherProvider = provider === "aws" ? "azure" : "aws";
                                    const otherUserId = userSession[otherProvider];

                                    if (otherUserId) {
                                        try {
                                            let otherInstances: any[] = [];

                                            if (otherProvider === "aws") {
                                                otherInstances = await this.cloudManager.refreshAWSInstances(otherUserId);
                                            } else if (otherProvider === "azure") {
                                                otherInstances = await this.cloudManager.refreshAzureInstances(otherUserId);
                                            }

                                            const formattedCurrent = (provider === "aws"
                                                ? result.ec2instances || []
                                                : result.vms || []
                                            ).map(inst => ({
                                                ...inst,
                                                provider
                                            }));

                                            const formattedOther = otherInstances.map(inst => ({
                                                ...inst,
                                                provider: otherProvider
                                            }));

                                            const combinedInstances = [...formattedCurrent, ...formattedOther];

                                            this.postMessage(webviewId, {
                                                type: "updateAllInstances",
                                                instances: combinedInstances
                                            });

                                            const awsId = provider === "aws" ? userId : otherUserId;
                                            const azureId = provider === "azure" ? userId : otherUserId;

                                            const multiGroups = await this.cloudManager.getMultiCloudGroupNames(awsId, azureId);
                                            console.log("🌐 Multi-cloud groups found:", multiGroups);

                                            // ✅ Send multi-group update to frontend
                                            this.postMessage(webviewId, {
                                                type: "updateMultiGroups",
                                                multiGroups,
                                                awsId,
                                                azureId
                                            });

                                            const sanitizeCost = (val: any): number => {
                                                const parsed = parseFloat((val || "0").toString().replace(/[^0-9.]/g, ""));
                                                return isNaN(parsed) ? 0 : parsed;
                                            };
                                            
                                            const currentCost = sanitizeCost(result.cost);
                                            const otherCost = sanitizeCost(await this.cloudManager.getMonthlyCostUnified(otherProvider, otherUserId));
                                            
                                            // 🧠 Add string values as floats and format as a string again
                                            const totalCost = (currentCost + otherCost).toFixed(2);
                                            
                                            // 💰 Post total combined cost
                                            this.postMessage(webviewId, {
                                                type: "updateCombinedCost",
                                                provider: "both",
                                                totalCost,
                                                awsId,
                                                azureId
                                            });
                                            
                                        } catch (err) {
                                            console.error("❌ Failed to refresh and combine instances for updateAllInstances:", err);
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
                                    window.showInformationMessage('Creating AWS Instance...');
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
                                    window.showInformationMessage('Creating Azure VM... This may take a few minutes.');
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
                                        type: "vmCreated",
                                        instanceId: vmId.vmId,
                                        instanceName: vmId.vmName,
                                        userId: instanceUserId,
                                        region: payload.region,
                                        status: "running",
                                        subscriptionId: payload.subscriptionId,  
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
                    case "refreshazureinstances":
                        console.log("📩 Received request to refresh Azure VMs");

                        if (!userSession["azure"]) {
                            console.error("❌ No authenticated Azure user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with Azure first!");
                            return;
                        }

                        const userIdAzureRef = userSession["azure"];

                        try {
                            // ✅ Call the function in CloudManager to fetch updated VMs
                            window.showInformationMessage("Refreshing Azure VMs...");
                            const updatedVMs = await this.cloudManager.refreshAzureInstances(userIdAzureRef);
                            window.showInformationMessage("Azure Vms Updated");
                            // ✅ Send the updated VM list back to the Webview
                            this.postMessage(webviewId, { 
                                type: "updateVMs", 
                                VMs: updatedVMs, 
                                userId: userIdAzureRef 
                            });

                            console.log("✅ Successfully refreshed Azure VMs");

                        } catch (error) {
                            console.error(`❌ Error refreshing Azure VMs for user ${userIdAzureRef}:`, error);
                            window.showErrorMessage(`Error refreshing Azure VMs: ${error}`);
                        }
                        break;

                    case "refreshAllInstances":
                        console.log("📩 Received request to refresh ALL instances");

                        const userIdAwsAll = userSession["aws"];
                        const userIdAzureAll = userSession["azure"];

                        if (!userIdAwsAll && !userIdAzureAll) {
                            console.error("❌ No authenticated AWS or Azure user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with at least one provider first!");
                            return;
                        }

                        try {
                            window.showInformationMessage("Refreshing All Instances...");

                            const awsInstances = userIdAwsAll
                                ? await this.cloudManager.refreshAWSInstances(userIdAwsAll)
                                : [];
                            const azureInstances = userIdAzureAll
                                ? await this.cloudManager.refreshAzureInstances(userIdAzureAll)
                                : [];

                            const formattedAwsInstances = awsInstances.map(inst => ({
                                ...inst,
                                provider: "aws"
                            }));

                            const formattedAzureInstances = azureInstances.map(inst => ({
                                ...inst,
                                provider: "azure"
                            }));

                            const combinedInstances = [...formattedAwsInstances, ...formattedAzureInstances];

                            this.postMessage(webviewId, {
                                type: "updateAllInstances",
                                instances: combinedInstances
                            });

                            console.log("✅ Successfully refreshed all instances");

                        } catch (error) {
                            console.error("❌ Error refreshing all instances:", error);
                            window.showErrorMessage(`Error refreshing instances: ${error}`);
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
                    case "terminateVMs":
                        console.log("📩 Received terminateVMs message:", data); // Debugging log

                        // Ensure Azure user session exists
                        if (!userSession["azure"]) {
                            console.error("❌ No authenticated Azure user found. Please authenticate first!");
                            window.showErrorMessage("Please authenticate with Azure first!");
                            return;
                        }

                        const userIdAzureTer = userSession["azure"];

                        // 🔥 Fix: Ensure `payload` exists and contains valid `vms` array
                        if (!payload || !payload.vms || !Array.isArray(payload.vms) || payload.vms.length === 0) {
                            console.warn("❌ Invalid termination request: No VM IDs provided.");
                            window.showErrorMessage("No VMs selected for termination.");
                            return;
                        }

                        // Extract VM IDs and Subscription IDs
                        const vmsToTerminate = payload.vms.map((vm: { vmId: string; subscriptionId: string }) => ({
                            vmId: vm.vmId,
                            subscriptionId: vm.subscriptionId
                        }));

                        console.log(`📤 Initiating termination for Azure VMs (User: ${userIdAzureTer}):`, vmsToTerminate);
                        window.showInformationMessage(`Terminating ${vmsToTerminate.length} VM(s)...`);

                        try {
                            // ✅ Call `deleteVMs` in `CloudManager` and pass VM IDs and Subscription IDs
                            await this.cloudManager.deleteVMs(userIdAzureTer, vmsToTerminate);
                            console.log(`✅ Successfully initiated termination for VMs:`, vmsToTerminate);

                            // ✅ Notify webview that VMs were terminated
                            this.postMessage(webviewId, { 
                                type: "terminatedVMs", 
                                terminatedVMs: vmsToTerminate, 
                                userId: userIdAzureTer
                            });

                        } catch (error) {
                            console.error(`❌ Error terminating VMs for user ${userIdAzureTer}:`, error);
                            window.showErrorMessage(`Error terminating VMs: ${error}`);
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
                    case "startVMs":
                        console.log("📩 Received startVMs message:", data); // Debugging log

                        // Ensure Azure user session exists
                        if (!userSession["azure"]) {
                            console.error("❌ No authenticated Azure user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with Azure first!");
                            return;
                        }

                        const userIdAzureStart = userSession["azure"];

                        // 🔥 Fix: Ensure `payload` exists and contains valid `vms` array
                        if (!payload || !payload.vms || !Array.isArray(payload.vms) || payload.vms.length === 0) {
                            console.warn("❌ Invalid start request: No VM IDs provided.");
                            window.showErrorMessage("No VMs selected for start.");
                            return;
                        }

                        // Extract VM IDs and Subscription IDs
                        const vmsToStart = payload.vms.map((vm: { vmId: string; subscriptionId: string }) => ({
                            vmId: vm.vmId,
                            subscriptionId: vm.subscriptionId
                        }));

                        console.log(`📤 Initiating start for Azure VMs (User: ${userIdAzureStart}):`, vmsToStart);
                        window.showInformationMessage(`Starting ${vmsToStart.length} VM(s)...`);

                        try {
                            // ✅ Call `startVMs` in `CloudManager` and pass VM IDs and Subscription IDs
                            await this.cloudManager.startVMs(userIdAzureStart, vmsToStart);
                            console.log(`✅ Successfully initiated start for VMs:`, vmsToStart);

                            // ✅ Notify webview that VMs were started
                            this.postMessage(webviewId, { 
                                type: "startedVMs", 
                                startedVMs: vmsToStart, 
                                userId: userIdAzureStart
                            });

                        } catch (error) {
                            console.error(`❌ Error starting VMs for user ${userIdAzureStart}:`, error);
                            window.showErrorMessage(`Error starting VMs: ${error}`);
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
                            const groupname = await this.cloudManager.createGroup(
                                provider,
                                { [provider]: userIdCreateGroup },
                                { [provider]: instancesNewGroup },
                                [] // Optional subscription IDs (only used if provider is "azure" or "both")
                              );
                              
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
                            this.postMessage(webviewId, {
                                type: "newGroupNameAws",
                                provider: "azure",
                                groupName: groupname, 
                                instances: instancesNewGroup,
                                userId: userIdCreateGroup
                            }); 

                            const userIdAwsCreate = userSession["aws"];
                            const userIdAzureCreate = userSession["azure"];

                            if (userIdAwsCreate && userIdAzureCreate) {
                                this.postMessage(webviewId, {
                                    type: "multiGroupCreated",
                                    provider: "both",
                                    groupname,
                                    instances: {
                                        aws: provider === "aws" ? instancesNewGroup : [],
                                        azure: provider === "azure" ? instancesNewGroup : []
                                    },
                                    userIdAws: userIdAwsCreate,
                                    userIdAzure: userIdAzureCreate
                                });
                            }

                        } catch (error) {
                            console.error(`❌ Error creating group for ${provider.toUpperCase()} user ${userIdCreateGroup}:`, error);
                            window.showErrorMessage(`Error creating group: ${error}`);
                        }
                        break;
                        case "createGroupAzure":
                            console.log(`🔹 Received createGroupAzure request from webview ${webviewId}:`, data);
                        
                            if (!webviewId) {
                                console.error("❌ Missing webviewId in createGroupAzure request.");
                                window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                                return;
                            }
                        
                            const azureUserId = userSession["azure"];
                        
                            if (!azureUserId) {
                                console.error("❌ No authenticated Azure user found. Please authenticate first.");
                                window.showErrorMessage("Please authenticate with Azure first!");
                                return;
                            }
                        
                            if (!payload || !Array.isArray(payload.instances) || payload.instances.length === 0) {
                                console.warn("❌ Invalid Azure group creation request: Missing instances.");
                                window.showErrorMessage("Missing instances for Azure group creation.");
                                return;
                            }
                        
                            const instanceIdsCreate: string[] = payload.instances.map((i: { vmId: string }) => i.vmId);
                            const subscriptionIds: string[] = payload.instances.map((i: { subscriptionId: string }) => i.subscriptionId);
                        
                            console.log(`📤 Creating AZURE Group for userId: ${azureUserId}`, instanceIdsCreate);
                            window.showInformationMessage(`Creating Azure Group with ${instanceIdsCreate.length} instance(s).`);
                        
                            try {
                                const groupname = await this.cloudManager.createGroup(
                                    "azure",
                                    { azure: azureUserId }, // userIds object
                                    { azure: instanceIdsCreate }, // instanceLists object
                                    subscriptionIds // Azure-specific
                                  );
                                  
                        
                                if (!groupname) {
                                    return;
                                }
                        
                                console.log("✅ Successfully created Azure group.");
                        
                                this.postMessage(webviewId, {
                                    type: "groupCreatedAzure",
                                    provider: "azure",
                                    groupname,
                                    instances: payload.instances,
                                    userId: azureUserId
                                });
                        
                                this.postMessage(webviewId, {
                                    type: "newGroupNameAzure",
                                    provider: "azure",
                                    groupName: groupname, 
                                    instances: payload.instances,
                                    userId: azureUserId
                                });

                                const userIdAwsCreate = userSession["aws"];
                                if (userIdAwsCreate) {
                                    this.postMessage(webviewId, {
                                        type: "multiGroupCreated",
                                        provider: "both",
                                        groupname,
                                        instances: {
                                            aws: [],
                                            azure: instanceIdsCreate
                                        },
                                        userIdAws: userIdAwsCreate,
                                        userIdAzure: azureUserId
                                    });
                                }
                        
                            } catch (error) {
                                console.error(`❌ Error creating Azure group for user ${azureUserId}:`, error);
                                window.showErrorMessage(`Error creating Azure group: ${error}`);
                            }
                            break; 
                    
                    case "createMultiGroup":
                        console.log(`🔹 Received createMultiGroup request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in createMultiGroup request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        const userSessionMulti = this.userSessions.get(webviewId);
                        const userIdAwsCreate = userSessionMulti?.["aws"];
                        const userIdAzureCreate = userSessionMulti?.["azure"];

                        if (!userIdAwsCreate || !userIdAzureCreate) {
                            console.error("❌ Both AWS and Azure users must be connected to create a multi-cloud group.");
                            window.showErrorMessage("Please connect to both AWS and Azure before creating a multi-cloud group.");
                            return;
                        }

                        if (!payload || typeof payload !== "object") {
                            console.error("❌ Invalid payload for createMultiGroup.");
                            window.showErrorMessage("Invalid multi-group creation request.");
                            return;
                        }

                        const { aws, azure }: { aws: string[]; azure: { vmId: string; subscriptionId: string }[] } = payload;

                        if ((!Array.isArray(aws) || aws.length === 0) && (!Array.isArray(azure) || azure.length === 0)) {
                            console.warn("❌ No AWS or Azure instances provided.");
                            window.showErrorMessage("Please select at least one AWS or Azure instance to create a group.");
                            return;
                        }

                        try {
                            const awsInstanceIds = aws;
                            const azureInstanceIds = azure.map((vm) => vm.vmId);
                            const azureSubs = azure.map((vm) => vm.subscriptionId);

                            console.log("📤 Creating multi-cloud group with:", {
                                awsInstanceIds,
                                azureInstanceIds
                            });

                            // ✅ Create group with both user IDs and instance IDs
                            const groupName = await this.cloudManager.createGroup(
                                "both",
                                { aws: userIdAwsCreate, azure: userIdAzureCreate },
                                { aws: awsInstanceIds, azure: azureInstanceIds },
                                azureSubs
                            );

                            if (!groupName) return;

                            // ✅ Multi-tab view
                            this.postMessage(webviewId, {
                                type: "multiGroupCreated",
                                provider: "both",
                                groupname: groupName,
                                instances: {
                                    aws: awsInstanceIds,
                                    azure: azureInstanceIds
                                },
                                userIdAws: userIdAwsCreate,
                                userIdAzure: userIdAzureCreate
                            });

                            // ✅ AWS-specific tab sync
                            if (awsInstanceIds.length > 0) {
                                this.postMessage(webviewId, {
                                    type: "groupCreated",
                                    provider: "aws",
                                    groupname: groupName,
                                    instances: awsInstanceIds,
                                    userId: userIdAwsCreate
                                });
                            }

                            // ✅ Azure-specific tab sync
                            if (azureInstanceIds.length > 0) {
                                const azurePayloadInstances = azure.map(vm => ({
                                    vmId: vm.vmId,
                                    subscriptionId: vm.subscriptionId
                                }));

                                this.postMessage(webviewId, {
                                    type: "groupCreatedAzure",
                                    provider: "azure",
                                    groupname: groupName,
                                    instances: azurePayloadInstances,
                                    userId: userIdAzureCreate
                                });
                            }

                            this.postMessage(webviewId, {
                                type: "newGroupNameMulti",
                                provider: "both",
                                groupName: groupName,
                                instances: {
                                    aws: awsInstanceIds,
                                    azure: azure.map(vm => ({ vmId: vm.vmId, subscriptionId: vm.subscriptionId }))
                                },
                                userIdAws: userIdAwsCreate,
                                userIdAzure: userIdAzureCreate
                            });
                            

                        } catch (error) {
                            console.error("❌ Error creating multi-group:", error);
                            window.showErrorMessage(`Error creating multi-cloud group: ${error}`);
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
                            const groupname = await this.cloudManager.addInstancesToGroup(provider, userIdAddGroup, instancesToAdd, []);

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

                            const session = this.userSessions.get(webviewId);
                            const userIdAzureAdd = session?.["azure"];
                            if (userIdAzureAdd) {
                                this.postMessage(webviewId, {
                                    type: "multiGroupCreated",
                                    provider: "both",
                                    groupname,
                                    instances: {
                                        aws: instancesToAdd,
                                        azure: []
                                    },
                                    userIdAws: userIdAddGroup,
                                    userIdAzure: userIdAzureAdd
                                });
                            }
                        } catch (error) {
                            console.error(`❌ Error adding instances to group for user ${userIdAddGroup}:`, error);
                            window.showErrorMessage(`Error adding instances: ${error}`);
                        }
                        break;
                        case "addToGroupAzure":
                            console.log(`🔹 Received addToGroupAzure request from webview ${webviewId}:`, data);
                        
                            if (!webviewId) {
                                console.error("❌ Missing webviewId in addToGroupAzure request.");
                                window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                                return;
                            }
                        
                            const azureUserIdAddGroup = userSession["azure"];
                        
                            if (!azureUserIdAddGroup) {
                                console.error("❌ No authenticated Azure user found. Please authenticate first.");
                                window.showErrorMessage("Please authenticate with Azure first!");
                                return;
                            }
                        
                            if (!payload || !Array.isArray(payload.instances) || payload.instances.length === 0) {
                                console.warn("❌ Invalid add request: Missing instances.");
                                window.showErrorMessage("Missing Azure instances for adding to group.");
                                return;
                            }
                        
                            // ✅ Extract VM and subscription IDs
                            const instanceIdsToAdd: string[] = payload.instances.map((i: { vmId: string }) => i.vmId);
                            const subscriptionIdsToAdd: string[] = payload.instances.map((i: { subscriptionId: string }) => i.subscriptionId);
                        
                            console.log(`📤 Adding instances to AZURE group for userId: ${azureUserIdAddGroup}`, instanceIdsToAdd);
                            window.showInformationMessage(`Adding ${instanceIdsToAdd.length} Azure instance(s) to a group.`);
                        
                            try {
                                const groupname = await this.cloudManager.addInstancesToGroup(
                                    "azure",
                                    azureUserIdAddGroup,
                                    instanceIdsToAdd,
                                    subscriptionIdsToAdd
                                );
                        
                                if (!groupname) return;
                        
                                console.log(`✅ Successfully added Azure instances to group: ${instanceIdsToAdd.join(", ")}`);
                                console.log("group name: ", groupname);
                        
                                // ✅ Notify the Webview to update
                                this.postMessage(webviewId, {
                                    type: "groupCreatedAzure",
                                    provider: "azure",
                                    groupname,
                                    instances: payload.instances,
                                    userId: azureUserIdAddGroup
                                });

                                const session = this.userSessions.get(webviewId);
                                const userIdAwsAdd = session?.["aws"];
                                if (userIdAwsAdd) {
                                    this.postMessage(webviewId, {
                                        type: "multiGroupCreated",
                                        provider: "both",
                                        groupname,
                                        instances: {
                                            aws: [],
                                            azure: instanceIdsToAdd
                                        },
                                        userIdAws: userIdAwsAdd,
                                        userIdAzure: azureUserIdAddGroup
                                    });
                                }
                        
                            } catch (error) {
                                console.error(`❌ Error adding Azure instances to group for user ${azureUserIdAddGroup}:`, error);
                                window.showErrorMessage(`Error adding Azure instances to group: ${error}`);
                            }
                        
                            break;   
                            
                    case "addToMultiGroup":
                        console.log(`🔹 Received addToMultiGroup request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in addToMultiGroup request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        const sessionMultiAdd = this.userSessions.get(webviewId);
                        const userIdAwsAdd = sessionMultiAdd?.["aws"];
                        const userIdAzureAdd = sessionMultiAdd?.["azure"];

                        if (!userIdAwsAdd || !userIdAzureAdd) {
                            console.error("❌ Both AWS and Azure users must be connected to add instances to a multi-cloud group.");
                            window.showErrorMessage("Please connect to both AWS and Azure before performing this action.");
                            return;
                        }

                        if (!payload || typeof payload !== "object") {
                            console.error("❌ Invalid payload for addToMultiGroup.");
                            window.showErrorMessage("Invalid request format.");
                            return;
                        }

                        const awsInstances: string[] = payload.aws;
                        const azureVMs: { vmId: string; subscriptionId: string }[] = payload.azure;

                        if ((!Array.isArray(awsInstances) || awsInstances.length === 0) && (!Array.isArray(azureVMs) || azureVMs.length === 0)) {
                            console.warn("❌ No AWS or Azure instances provided.");
                            window.showErrorMessage("Please select at least one AWS or Azure instance to add to a group.");
                            return;
                        }

                        try {
                            const awsInstanceIds: string[] = awsInstances;
                            const azureInstanceIds: string[] = azureVMs.map(vm => vm.vmId);
                            const azureSubs: string[] = azureVMs.map(vm => vm.subscriptionId);

                            console.log("📤 Adding to multi-cloud group:", {
                                awsInstanceIds,
                                azureInstanceIds
                            });

                            // ✅ Call updated CloudManager logic
                            const groupName = await this.cloudManager.addInstancesToGroup(
                                "both",
                                { aws: userIdAwsAdd, azure: userIdAzureAdd },
                                { aws: awsInstanceIds, azure: azureInstanceIds },
                                azureSubs
                            );

                            if (!groupName) return;

                            // ✅ Notify UI
                            this.postMessage(webviewId, {
                                type: "multiGroupCreated",
                                provider: "both",
                                groupname: groupName,
                                instances: {
                                    aws: awsInstanceIds,
                                    azure: azureInstanceIds
                                },
                                userIdAws: userIdAwsAdd,
                                userIdAzure: userIdAzureAdd
                            }); 
                            
                            if (awsInstanceIds.length > 0) {
                                this.postMessage(webviewId, {
                                    type: "groupCreated",
                                    provider: "aws",
                                    groupname: groupName,
                                    instances: awsInstanceIds,
                                    userId: userIdAwsAdd
                                });
                            }
                    
                            // ✅ Also send Azure-specific update if any Azure instances were added
                            if (azureInstanceIds.length > 0) {
                                this.postMessage(webviewId, {
                                    type: "groupCreatedAzure",
                                    provider: "azure",
                                    groupname: groupName,
                                    instances: azureVMs, // use original payload so it includes subscriptionId
                                    userId: userIdAzureAdd
                                });
                            }

                        } catch (error) {
                            console.error("❌ Error updating multi-cloud group:", error);
                            window.showErrorMessage(`Error adding to group: ${error}`);
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

                            const session = this.userSessions.get(webviewId);
                            const userIdAzure = session?.["azure"];
                            if (userIdAzure) {
                                this.postMessage(webviewId, {
                                    type: "multiGroupCreated",
                                    provider: "both",
                                    groupname,
                                    instances: {
                                        aws: instancesToRemove,
                                        azure: []  // Nothing removed from Azure in this request
                                    },
                                    userIdAws: userIdRemoveGroup,
                                    userIdAzure
                                });
                            }
                        } catch (error) {
                            console.error(`❌ Error removing instances from group for user ${userIdRemoveGroup}:`, error);
                            window.showErrorMessage(`Error removing instances: ${error}`);
                        }
                        break;
                    case "removeFromGroupAzure":
                        if (!webviewId) {
                            console.error("❌ Missing webviewId in removeFromGroupAzure request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        const azureUserIdRemoveGroup = userSession["azure"];

                        if (!azureUserIdRemoveGroup) {
                            console.error("❌ No authenticated Azure user found. Please authenticate first.");
                            window.showErrorMessage("Please authenticate with Azure first!");
                            return;
                        }

                        if (!payload || !Array.isArray(payload.instances) || payload.instances.length === 0) {
                            console.warn("❌ Invalid Azure remove request: Missing instances.");
                            window.showErrorMessage("Missing Azure instances for removal from group.");
                            return;
                        }

                        const instanceIdsToRemove: string[] = payload.instances.map((i: { vmId: string }) => i.vmId);

                        window.showInformationMessage(`Removing ${instanceIdsToRemove.length} Azure instance(s) from a group.`);

                        try {
                            const groupname = await this.cloudManager.removeInstancesFromGroup(
                                "azure",
                                azureUserIdRemoveGroup,
                                instanceIdsToRemove
                            );

                            if (!groupname) return;

                            console.log(`✅ Successfully removed Azure instances from group: ${instanceIdsToRemove.join(", ")}`);
                            console.log("group name: ", groupname);

                            this.postMessage(webviewId, {
                                type: "groupCreatedAzure",
                                provider: "azure",
                                groupname,
                                instances: payload.instances, // preserve structure for frontend
                                userId: azureUserIdRemoveGroup
                            });

                            const session = this.userSessions.get(webviewId);
                            const userIdAws = session?.["aws"];
                            if (userIdAws) {
                                this.postMessage(webviewId, {
                                    type: "multiGroupCreated",
                                    provider: "both",
                                    groupname,
                                    instances: {
                                        aws: [],
                                        azure: instanceIdsToRemove
                                    },
                                    userIdAws,
                                    userIdAzure: azureUserIdRemoveGroup
                                });
                            }

                        } catch (error) {
                            console.error(`❌ Error removing Azure instances from group for user ${azureUserIdRemoveGroup}:`, error);
                            window.showErrorMessage(`Error removing Azure instances: ${error}`);
                        }

                        break;

                    case "removeFromMultiGroup":
                        console.log(`🔹 Received removeFromMultiGroup request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in removeFromMultiGroup request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        const sessionMultiRemove = this.userSessions.get(webviewId);
                        const userIdAwsRemove = sessionMultiRemove?.["aws"];
                        const userIdAzureRemove = sessionMultiRemove?.["azure"];

                        if (!userIdAwsRemove || !userIdAzureRemove) {
                            console.error("❌ Both AWS and Azure users must be connected to remove instances from a multi-cloud group.");
                            window.showErrorMessage("Please connect to both AWS and Azure before performing this action.");
                            return;
                        }

                        if (!payload || typeof payload !== "object") {
                            console.error("❌ Invalid payload for removeFromMultiGroup.");
                            window.showErrorMessage("Invalid request format.");
                            return;
                        }

                        const {
                            aws: awsInstancesToRemove,
                            azure: azureInstancesToRemove
                        }: {
                            aws: string[];
                            azure: { vmId: string; subscriptionId: string }[];
                        } = payload;

                        if ((!Array.isArray(awsInstancesToRemove) || awsInstancesToRemove.length === 0) &&
                            (!Array.isArray(azureInstancesToRemove) || azureInstancesToRemove.length === 0)) {
                            console.warn("❌ No AWS or Azure instances provided.");
                            window.showErrorMessage("Please select at least one AWS or Azure instance to remove from a group.");
                            return;
                        }

                        try {
                            const azureVmIds = azureInstancesToRemove.map(vm => vm.vmId);

                            console.log("📤 Removing from multi-cloud group:", {
                                awsInstanceIds: awsInstancesToRemove,
                                azureVmIds
                            });

                            // ✅ Call CloudManager logic to remove from group
                            const groupName = await this.cloudManager.removeInstancesFromGroup(
                                "both",
                                { aws: userIdAwsRemove, azure: userIdAzureRemove },
                                { aws: awsInstancesToRemove, azure: azureVmIds }
                            );

                            if (!groupName) return;

                            // ✅ Notify frontend
                            this.postMessage(webviewId, {
                                type: "multiGroupCreated",
                                provider: "both",
                                groupname: groupName,
                                instances: {
                                    aws: awsInstancesToRemove,
                                    azure: azureVmIds
                                },
                                userIdAws: userIdAwsRemove,
                                userIdAzure: userIdAzureRemove
                            });

                            if (awsInstancesToRemove.length > 0) {
                                this.postMessage(webviewId, {
                                    type: "groupCreated",
                                    provider: "aws",
                                    groupname: groupName,
                                    instances: awsInstancesToRemove,
                                    userId: userIdAwsRemove
                                });
                            }
                    
                            // ✅ Azure tab sync (if applicable)
                            if (azureVmIds.length > 0) {
                                this.postMessage(webviewId, {
                                    type: "groupCreatedAzure",
                                    provider: "azure",
                                    groupname: groupName,
                                    instances: azureInstancesToRemove, // includes subscriptionId
                                    userId: userIdAzureRemove
                                });
                            }

                        } catch (error) {
                            console.error("❌ Error removing instances from multi-cloud group:", error);
                            window.showErrorMessage(`Error removing instances from group: ${error}`);
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
                            const time = await this.cloudManager.setGroupDowntime(provider, groupName);

                            console.log(`✅ Successfully set downtime for ${provider.toUpperCase()} group '${groupName}'.`);

                            // ✅ Notify the webview about the updated downtime
                            if (provider === "aws") {
                                this.postMessage(webviewId, {
                                    type: "groupDowntimeSet",
                                    provider,
                                    time, 
                                    groupName,
                                    userId: userIdSetDowntime
                                });
                            }
                            else if (provider === "azure") {
                                this.postMessage(webviewId, {
                                    type: "groupDowntimeSetAzure",
                                    provider,
                                    time, 
                                    groupName,
                                    userId: userIdSetDowntime
                                });
                            }
                        } catch (error) {
                            console.error(`❌ Error setting downtime for group '${groupName}' for ${provider.toUpperCase()} user ${userIdSetDowntime}:`, error);
                            window.showErrorMessage(`Error setting group downtime: ${error}`);
                        }
                        break;

                    case "setGroupDowntimeMulti":
                        console.log(`🔹 Received setGroupDowntimeMulti request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in setGroupDowntimeMulti request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        const multiSessionSet = this.userSessions.get(webviewId);
                        const userIdAwsSet = multiSessionSet?.["aws"];
                        const userIdAzureSet = multiSessionSet?.["azure"];

                        if (!userIdAwsSet || !userIdAzureSet) {
                            console.error("❌ Both AWS and Azure users must be authenticated to set multi-cloud group downtime.");
                            window.showErrorMessage("Please authenticate with both AWS and Azure before setting downtime.");
                            return;
                        }

                        if (!payload || !payload.groupName) {
                            console.warn("❌ Invalid downtime request: Missing group name.");
                            window.showErrorMessage("Missing group name for setting multi-cloud downtime.");
                            return;
                        }

                        const { groupName: multiGroupName } = payload;

                        console.log(`📤 Setting downtime for multi-cloud group '${multiGroupName}'.`);
                        window.showInformationMessage(`Setting downtime for multi-cloud group '${multiGroupName}'.`);

                        try {
                            const time = await this.cloudManager.setGroupDowntime("both", multiGroupName); 

                            if (!time) return;

                            console.log(`✅ Downtime set for multi-cloud group '${multiGroupName}':`, time);

                            // Post to AWS UI
                            this.postMessage(webviewId, {
                                type: "groupDowntimeSet",
                                provider: "aws",
                                time,
                                groupName: multiGroupName,
                                userId: userIdAwsSet
                            });

                            // Post to Azure UI
                            this.postMessage(webviewId, {
                                type: "groupDowntimeSetAzure",
                                provider: "azure",
                                time,
                                groupName: multiGroupName,
                                userId: userIdAzureSet
                            });

                            // ✅ Post to Multi UI
                            this.postMessage(webviewId, {
                                type: "groupDowntimeSetMulti",
                                provider: "both",
                                time,
                                groupName: multiGroupName,
                                userIdAws: userIdAwsSet,
                                userIdAzure: userIdAzureSet
                            });

                        } catch (error) {
                            console.error(`❌ Error setting downtime for multi-cloud group '${multiGroupName}':`, error);
                            window.showErrorMessage(`Error setting multi-cloud group downtime: ${error}`);
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
                            if (provider === "aws") {
                                this.postMessage(webviewId, {
                                    type: "groupDowntimeDeleted",
                                    provider,
                                    groupNameDel,
                                    userId: userIdDeleteDowntime
                                });
                            }
                            else if (provider === "azure") {
                                this.postMessage(webviewId, {
                                    type: "groupDowntimeDeletedAzure",
                                    provider,
                                    groupNameDel,
                                    userId: userIdDeleteDowntime
                                });
                            }

                        } catch (error) {
                            console.error(`❌ Error deleting downtime for group '${groupNameDel}' for ${provider.toUpperCase()} user ${userIdDeleteDowntime}:`, error);
                            window.showErrorMessage(`Error deleting group downtime: ${error}`);
                        }
                        break;

                    case "deleteGroupDowntimeMulti":
                        console.log(`🔹 Received deleteGroupDowntimeMulti request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in deleteGroupDowntimeMulti request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        const sessionMultiDelete = this.userSessions.get(webviewId);
                        const userIdAwsDelete = sessionMultiDelete?.["aws"];
                        const userIdAzureDelete = sessionMultiDelete?.["azure"];

                        if (!userIdAwsDelete || !userIdAzureDelete) {
                            console.error("❌ Both AWS and Azure users must be authenticated to delete multi-group downtime.");
                            window.showErrorMessage("Please authenticate with both AWS and Azure first!");
                            return;
                        }

                        if (!payload || !payload.groupName) {
                            console.warn("❌ Invalid downtime delete request: Missing group name.");
                            window.showErrorMessage("Missing group name for deleting downtime.");
                            return;
                        }

                        const multiGroupNameDelete = payload.groupName;

                        console.log(`📤 Deleting downtime for MULTI-CLOUD group '${multiGroupNameDelete}'.`);
                        window.showInformationMessage(`Deleting downtime for group '${multiGroupNameDelete}'.`);

                        try {
                            const success = await this.cloudManager.removeGroupDowntime(multiGroupNameDelete);

                            if (!success) {
                                console.warn(`⚠️ No downtime found for group '${multiGroupNameDelete}', or deletion failed.`);
                                window.showErrorMessage(`No downtime found for group '${multiGroupNameDelete}', or deletion failed.`);
                                return;
                            }

                            console.log(`✅ Successfully removed downtime for MULTI-CLOUD group '${multiGroupNameDelete}'.`);

                            // 🔁 Notify AWS tab
                            this.postMessage(webviewId, {
                                type: "groupDowntimeDeleted",
                                provider: "aws",
                                groupNameDel: multiGroupNameDelete,
                                userId: userIdAwsDelete
                            });

                            // 🔁 Notify Azure tab
                            this.postMessage(webviewId, {
                                type: "groupDowntimeDeletedAzure",
                                provider: "azure",
                                groupNameDel: multiGroupNameDelete,
                                userId: userIdAzureDelete
                            });

                            // 🌐 Notify Multi-tab
                            this.postMessage(webviewId, {
                                type: "groupDowntimeDeletedMulti",
                                provider: "both",
                                groupNameDel: multiGroupNameDelete,
                                userIdAws: userIdAwsDelete,
                                userIdAzure: userIdAzureDelete
                            });

                        } catch (error) {
                            console.error(`❌ Error deleting downtime for multi-cloud group '${multiGroupNameDelete}':`, error);
                            window.showErrorMessage(`Error deleting multi-cloud group downtime: ${error}`);
                        }

                        break;
                    case "viewGroupDowntime":
                        console.log(`🔹 Received viewGroupDowntime request from webview ${webviewId}:`, data);

                        if (!webviewId) {
                            console.error("❌ Missing webviewId in viewGroupDowntime request.");
                            window.showErrorMessage("Webview ID is missing. Please refresh and try again.");
                            return;
                        }

                        if (!payload || !payload.groupName) {
                            console.warn("❌ Invalid view downtime request: Missing group name.");
                            window.showErrorMessage("Missing group name for viewing downtime.");
                            return;
                        }

                        try {
                            const { groupName } = payload;

                            // ✅ Call the CloudManager method to show downtime info
                            await this.cloudManager.viewGroupDowntime(groupName);

                        } catch (error) {
                            console.error("❌ Error displaying downtime:", error);
                            window.showErrorMessage(`Failed to view downtime for group: ${error}`);
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
           <title>CloudDock</title>
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
                            console.log("✅ Azure connected: ", message)
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

                            const instanceList = document.querySelector("#instancesTable");
                            instanceList.innerHTML = ""; // Clear existing items

                            if (!message.instances || message.instances.length === 0) {
                                console.warn("⚠️ No instances received.");
                                const noItem = document.createElement("li");
                                noItem.id = "initialRow";
                                noItem.style.color = "gray";
                                noItem.style.listStyleType = "none";
                                noItem.style.textAlign = "center";
                                noItem.textContent = "No instances found.";
                                instanceList.appendChild(noItem);
                                return;
                            }

                            message.instances.forEach(instance => {
                                const listItem = document.createElement("li");
                                listItem.className = "ec2-entry";

                                const groupName = instance.groupName || "N/A";
                                let shutdownSchedule = instance.shutdownSchedule;

                                if (!shutdownSchedule || shutdownSchedule === "N/A" || shutdownSchedule.trim() === "N/A | N/A") {
                                    shutdownSchedule = "N/A";
                                }

                                // Optionally format shutdown times
                                if (shutdownSchedule.includes("|") && shutdownSchedule !== "N/A") {
                                    const [start, end] = shutdownSchedule.split("|").map(s => s.trim());
                                    shutdownSchedule = \`Start: \${start}, End: \${end}\`;
                                }

                                // Main row (checkbox + name)
                                const mainContent = document.createElement("div");

                                const checkbox = document.createElement("input");
                                checkbox.type = "checkbox";
                                checkbox.className = "ec2-checkbox";

                                const hiddenId = document.createElement("span");
                                hiddenId.className = "instance-id";
                                hiddenId.style.display = "none";
                                hiddenId.textContent = instance.instanceId;

                                const nameText = document.createElement("strong");
                                nameText.textContent = instance.instanceName || "N/A";

                                mainContent.appendChild(checkbox);
                                mainContent.appendChild(hiddenId);
                                mainContent.appendChild(document.createTextNode(" "));
                                mainContent.appendChild(nameText);

                                listItem.appendChild(mainContent);

                                // Sub-bullets
                                const subList = document.createElement("ul");

                                const regionItem = document.createElement("li");
                                regionItem.textContent = \`Region: \${instance.region}\`;

                                const groupItem = document.createElement("li");
                                groupItem.textContent = \`Group: \${groupName}\`;

                                const shutdownItem = document.createElement("li");
                                shutdownItem.style.display = "none";
                                shutdownItem.textContent = \`Shutdown Schedule: \${shutdownSchedule}\`;

                                const statusItem = document.createElement("li");
                                statusItem.textContent = \`Status: \${instance.state}\`;

                                subList.appendChild(regionItem);
                                subList.appendChild(groupItem);
                                subList.appendChild(shutdownItem);
                                subList.appendChild(statusItem);

                                listItem.appendChild(subList);
                                instanceList.appendChild(listItem);
                            });
                        }

                        if (message.type === "updateVMs") {
                            console.log("✅ Received VMs:", message.VMs);

                            const vmList = document.querySelector("#vmsTable");
                            vmList.innerHTML = ""; // Clear existing entries

                            if (!message.VMs || message.VMs.length === 0) {
                                console.warn("⚠️ No VMs received.");
                                const noVMItem = document.createElement("li");
                                noVMItem.id = "initialRow";
                                noVMItem.style.color = "gray";
                                noVMItem.style.listStyleType = "none";
                                noVMItem.style.textAlign = "center";
                                noVMItem.textContent = "No active VMs found.";
                                vmList.appendChild(noVMItem);
                                return;
                            }

                            message.VMs.forEach(vm => {
                                const listItem = document.createElement("li");
                                listItem.className = "vm-entry";

                                const groupName = vm.groupName || "N/A";
                                let shutdownSchedule = vm.shutdownSchedule;

                                if (!shutdownSchedule || shutdownSchedule === "N/A" || shutdownSchedule.trim() === "N/A | N/A") {
                                    shutdownSchedule = "N/A";
                                }

                                let statusText = (vm.status || "Unknown").split(" ").pop().trim();

                                // Main bullet point: name + checkbox
                                const mainContent = document.createElement("div");

                                const checkbox = document.createElement("input");
                                checkbox.type = "checkbox";
                                checkbox.className = "vm-checkbox";

                                const hiddenId = document.createElement("span");
                                hiddenId.className = "vm-id";
                                hiddenId.style.display = "none";
                                hiddenId.textContent = vm.id;

                                const hiddenSub = document.createElement("span");
                                hiddenSub.className = "vm-subscription";
                                hiddenSub.style.display = "none";
                                hiddenSub.textContent = vm.subscriptionId;

                                const nameText = document.createElement("strong");
                                nameText.textContent = vm.name || "N/A";

                                mainContent.appendChild(checkbox);
                                mainContent.appendChild(hiddenId);
                                mainContent.appendChild(hiddenSub);
                                mainContent.appendChild(document.createTextNode(" "));
                                mainContent.appendChild(nameText);

                                listItem.appendChild(mainContent);

                                // Sub-bullet list
                                const subList = document.createElement("ul");

                                const regionItem = document.createElement("li");
                                regionItem.textContent = \`Region: \${vm.region}\`;

                                const groupItem = document.createElement("li");
                                groupItem.textContent = \`Group: \${groupName}\`;

                                const shutdownItem = document.createElement("li");
                                shutdownItem.style.display = "none";
                                shutdownItem.textContent = \`Shutdown Schedule: \${shutdownSchedule}\`;

                                const statusItem = document.createElement("li");
                                statusItem.textContent = \`Status: \${statusText}\`;

                                subList.appendChild(regionItem);
                                subList.appendChild(groupItem);
                                subList.appendChild(shutdownItem);
                                subList.appendChild(statusItem);

                                listItem.appendChild(subList);
                                vmList.appendChild(listItem);
                            });
                        }

                        if (message.type === "updateAllInstances") {
                            console.log("📦 Received combined AWS + Azure instances:", message.instances);

                            const listContainer = document.querySelector("#allinstancesTable");
                            listContainer.innerHTML = ""; // Clear previous entries

                            if (!message.instances || message.instances.length === 0) {
                                console.warn("⚠️ No combined instances received.");
                                const noItem = document.createElement("li");
                                noItem.id = "initialRow";
                                noItem.style.color = "gray";
                                noItem.style.listStyleType = "none";
                                noItem.style.textAlign = "center";
                                noItem.textContent = "No active instances found.";
                                listContainer.appendChild(noItem);
                                return;
                            }

                            message.instances.forEach(instance => {
                                const listItem = document.createElement("li");
                                listItem.className = "all-instance-entry";

                                const groupName = instance.groupName || "N/A";
                                let shutdownSchedule = instance.shutdownSchedule;

                                if (!shutdownSchedule || shutdownSchedule === "N/A" || shutdownSchedule.trim() === "N/A | N/A") {
                                    shutdownSchedule = "N/A";
                                }

                                // Format shutdown time
                                if (shutdownSchedule.includes("|") && shutdownSchedule !== "N/A") {
                                    const [start, end] = shutdownSchedule.split("|").map(s => s.trim());
                                    shutdownSchedule = \`Start: \${start}, End: \${end}\`;
                                }

                                const statusText = (instance.status || instance.state || "Unknown").split(" ").pop().trim();

                                // Main bullet: name + checkbox
                                const mainContent = document.createElement("div");

                                const checkbox = document.createElement("input");
                                checkbox.type = "checkbox";
                                checkbox.className = "all-checkbox";

                                const hiddenId = document.createElement("span");
                                hiddenId.className = "all-instance-id";
                                hiddenId.style.display = "none";
                                hiddenId.textContent = instance.id || instance.instanceId;

                                const hiddenSub = document.createElement("span");
                                hiddenSub.className = "all-subscription";
                                hiddenSub.style.display = "none";
                                hiddenSub.textContent = instance.subscriptionId || instance.accountId || "";

                                const nameText = document.createElement("strong");
                                nameText.textContent = instance.name || instance.instanceName || "N/A";

                                mainContent.appendChild(checkbox);
                                mainContent.appendChild(hiddenId);
                                mainContent.appendChild(hiddenSub);
                                mainContent.appendChild(document.createTextNode(" "));
                                mainContent.appendChild(nameText);

                                listItem.appendChild(mainContent);

                                // Sub-bullets
                                const subList = document.createElement("ul");

                                const providerItem = document.createElement("li");
                                providerItem.textContent = \`Provider: \${instance.provider || "Unknown"}\`;

                                const regionItem = document.createElement("li");
                                regionItem.textContent = \`Region: \${instance.region || "N/A"}\`;

                                const groupItem = document.createElement("li");
                                groupItem.textContent = \`Group: \${groupName}\`;

                                const shutdownItem = document.createElement("li");
                                shutdownItem.style.display = "none";
                                shutdownItem.textContent = \`Shutdown Schedule: \${shutdownSchedule}\`;

                                const statusItem = document.createElement("li");
                                statusItem.textContent = \`Status: \${statusText}\`;

                                subList.appendChild(providerItem);
                                subList.appendChild(regionItem);
                                subList.appendChild(groupItem);
                                subList.appendChild(shutdownItem);
                                subList.appendChild(statusItem);

                                listItem.appendChild(subList);
                                listContainer.appendChild(listItem);
                            });
                        }

                        if (message.type === "instanceCreated") {
                            let instanceId = message.instanceId || "Unknown ID";
                            let instanceName = message.instanceName || "N/A";
                            const region = message.region || "N/A";

                            const instanceList = document.getElementById("instancesTable");

                            // 🔧 Remove placeholder row if it's still visible
                            for (const child of instanceList.children) {
                                const text = child.textContent.trim();
                                if (text === "Waiting for connection..." || text === "No instances found.") {
                                    instanceList.removeChild(child);
                                    break;
                                }
                            }

                            // Create list item for the new instance
                            const listItem = document.createElement("li");
                            listItem.className = "ec2-entry";

                            // Main content: checkbox + instance name
                            const mainContent = document.createElement("div");

                            const checkbox = document.createElement("input");
                            checkbox.type = "checkbox";
                            checkbox.className = "ec2-checkbox";

                            const hiddenId = document.createElement("span");
                            hiddenId.className = "instance-id";
                            hiddenId.style.display = "none";
                            hiddenId.textContent = instanceId;

                            const nameText = document.createElement("strong");
                            nameText.textContent = instanceName;

                            mainContent.appendChild(checkbox);
                            mainContent.appendChild(hiddenId);
                            mainContent.appendChild(document.createTextNode(" "));
                            mainContent.appendChild(nameText);

                            listItem.appendChild(mainContent);

                            // Sub-bullets: region, group, schedule, status
                            const subList = document.createElement("ul");

                            const regionItem = document.createElement("li");
                            regionItem.textContent = \`Region: \${region}\`;

                            const groupItem = document.createElement("li");
                            groupItem.textContent = \`Group: N/A\`;

                            const shutdownItem = document.createElement("li");
                            shutdownItem.style.display = "none";
                            shutdownItem.textContent = \`Shutdown Schedule: N/A\`;

                            const statusItem = document.createElement("li");
                            statusItem.textContent = \`Status: running\`;

                            subList.appendChild(regionItem);
                            subList.appendChild(groupItem);
                            subList.appendChild(shutdownItem);
                            subList.appendChild(statusItem);

                            listItem.appendChild(subList);
                            instanceList.appendChild(listItem);
                        }


                        if (message.type === "vmCreated") {
                            console.log("📩 Received instanceCreated message:", message);

                            const instanceId = message.instanceId || "Unknown ID";
                            const instanceName = message.instanceName || "N/A";
                            const status = message.status || "creating";
                            const subscriptionId = message.subscriptionId || "N/A";
                            const region = message.region || "N/A";

                            const vmList = document.querySelector("#vmsTable");

                            // ✅ Remove any placeholder row (either "Waiting for connection..." or "No active VMs found.")
                            for (const child of vmList.children) {
                                const text = child.textContent.trim();
                                if (text === "Waiting for connection..." || text === "No active VMs found.") {
                                    vmList.removeChild(child);
                                    break;
                                }
                            }

                            // Create list item (acts like a row)
                            const listItem = document.createElement("li");
                            listItem.className = "vm-entry";

                            // Top-level: checkbox + name
                            const mainContent = document.createElement("div");

                            const checkbox = document.createElement("input");
                            checkbox.type = "checkbox";
                            checkbox.className = "vm-checkbox";

                            const hiddenId = document.createElement("span");
                            hiddenId.className = "vm-id";
                            hiddenId.style.display = "none";
                            hiddenId.textContent = instanceId;

                            const hiddenSub = document.createElement("span");
                            hiddenSub.className = "vm-subscription";
                            hiddenSub.style.display = "none";
                            hiddenSub.textContent = subscriptionId;

                            const nameText = document.createElement("strong");
                            nameText.textContent = instanceName;

                            mainContent.appendChild(checkbox);
                            mainContent.appendChild(hiddenId);
                            mainContent.appendChild(hiddenSub);
                            mainContent.appendChild(document.createTextNode(" "));
                            mainContent.appendChild(nameText);

                            listItem.appendChild(mainContent);

                            // Sub-list: region, group, shutdown, status
                            const subList = document.createElement("ul");

                            const regionItem = document.createElement("li");
                            regionItem.textContent = \`Region: \${region}\`;

                            const groupItem = document.createElement("li");
                            groupItem.textContent = \`Group: N/A\`;

                            const shutdownItem = document.createElement("li");
                            shutdownItem.style.display = "none";
                            shutdownItem.textContent = \`Shutdown Schedule: N/A\`;

                            const statusItem = document.createElement("li");
                            statusItem.textContent = \`Status: \${status}\`;

                            subList.appendChild(regionItem);
                            subList.appendChild(groupItem);
                            subList.appendChild(shutdownItem);
                            subList.appendChild(statusItem);

                            listItem.appendChild(subList);
                            vmList.appendChild(listItem);
                        }

                        if (message.type === "groupDowntimeDeleted") {
                            console.log("✅ Downtime deleted for group:", message.groupNameDel);

                            const { groupNameDel } = message;

                            const instanceEntries = document.querySelectorAll("#instancesTable .ec2-entry");

                            instanceEntries.forEach(entry => {
                                const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim() === \`Group: \${groupNameDel}\`);

                                const shutdownItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim().startsWith("Shutdown Schedule:"));

                                if (groupItem && shutdownItem) {
                                    shutdownItem.style.display = "none";
                                    shutdownItem.textContent = "Shutdown Schedule: N/A";
                                }
                            });
                        }

                        if (message.type === "groupDowntimeDeletedMulti") {
                            console.log("✅ Downtime deleted for multi-cloud group:", message.groupNameDel);

                            const { groupNameDel } = message;

                            const instanceEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");

                            instanceEntries.forEach(entry => {
                                const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim() === \`Group: \${groupNameDel}\`);

                                const shutdownItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim().startsWith("Shutdown Schedule:"));

                                if (groupItem && shutdownItem) {
                                    shutdownItem.style.display = "none";
                                    shutdownItem.textContent = "Shutdown Schedule: N/A";
                                    console.log("🔹 Cleared shutdown schedule for multi-cloud instance in group:", groupNameDel);
                                }
                            });
                        }

                        if (message.type === "groupDowntimeDeletedAzure") {
                            const { groupNameDel } = message;

                            console.log("✅ Downtime deleted for Azure group:", groupNameDel);

                            // ✅ Find all VM entries in the list
                            const vmEntries = document.querySelectorAll("#vmsTable .vm-entry");

                            vmEntries.forEach(entry => {
                                const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim().startsWith("Group:"));

                                const shutdownItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim().startsWith("Shutdown Schedule:"));

                                if (groupItem && groupItem.textContent.trim() === \`Group: \${groupNameDel}\`) {
                                    console.log("🔁 Clearing shutdown schedule for VM in group:", groupNameDel);
                                    if (shutdownItem) {
                                        shutdownItem.display = "none";
                                        shutdownItem.textContent = "Shutdown Schedule: N/A";
                                    }
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
                            console.log("🔹 Updating UI for stopped AWS instances:", stoppedInstances);

                            // 🔄 Update AWS-only table
                            const instanceEntries = document.querySelectorAll("#instancesTable .ec2-entry");
                            stoppedInstances.forEach(instanceId => {
                                instanceEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".instance-id");
                                    if (idSpan && idSpan.textContent.trim() === instanceId) {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));
                                        if (statusItem) {
                                            statusItem.textContent = "Status: stopping";
                                        }
                                    }
                                });
                            });

                            // 🔄 Update multi-table
                            const multiEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");
                            stoppedInstances.forEach(instanceId => {
                                multiEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".all-instance-id");
                                    const providerItem = Array.from(entry.querySelectorAll("ul li"))
                                        .find(li => li.textContent.trim().startsWith("Provider:"));
                                    const provider = providerItem?.textContent.replace("Provider:", "").trim();

                                    if (idSpan && idSpan.textContent.trim() === instanceId && provider === "aws") {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));
                                        if (statusItem) {
                                            statusItem.textContent = "Status: stopping";
                                        }
                                    }
                                });
                            });
                        }

                        if (message.type === "stoppedVMs") {
                            const stoppedVMs = message.stoppedVMs;
                            console.log("🔹 Updating UI for stopped Azure VMs:", stoppedVMs);

                            // 🔄 Update Azure-only table
                            const vmEntries = document.querySelectorAll("#vmsTable .vm-entry");
                            stoppedVMs.forEach(vm => {
                                vmEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".vm-id");
                                    if (idSpan && idSpan.textContent.trim() === vm.vmId) {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));
                                        if (statusItem) {
                                            statusItem.textContent = "Status: deallocated";
                                        }
                                    }
                                });
                            });

                            // 🔄 Update multi-table
                            const multiEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");
                            stoppedVMs.forEach(vm => {
                                multiEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".all-instance-id");
                                    const providerItem = Array.from(entry.querySelectorAll("ul li"))
                                        .find(li => li.textContent.trim().startsWith("Provider:"));
                                    const provider = providerItem?.textContent.replace("Provider:", "").trim();

                                    if (idSpan && idSpan.textContent.trim() === vm.vmId && provider === "azure") {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));
                                        if (statusItem) {
                                            statusItem.textContent = "Status: stopped";
                                        }
                                    }
                                });
                            });
                        }

                        if (message.type === "terminatedResources") {
                            const terminatedInstances = message.terminatedInstances;
                            console.log("🛑 Updating status for terminated AWS instances:", terminatedInstances);

                            // 🔄 Update AWS-only table
                            const instanceEntries = document.querySelectorAll("#instancesTable .ec2-entry");
                            terminatedInstances.forEach(instanceId => {
                                instanceEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".instance-id");

                                    if (idSpan && idSpan.textContent.trim() === instanceId) {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));

                                        if (statusItem) {
                                            statusItem.textContent = "Status: terminated";
                                        }
                                    }
                                });
                            });

                            // 🔄 Update multi-table
                            const multiEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");
                            terminatedInstances.forEach(instanceId => {
                                multiEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".all-instance-id");
                                    const providerItem = Array.from(entry.querySelectorAll("ul li"))
                                        .find(li => li.textContent.trim().startsWith("Provider:"));
                                    const provider = providerItem?.textContent.replace("Provider:", "").trim();

                                    if (idSpan && idSpan.textContent.trim() === instanceId && provider === "aws") {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));

                                        if (statusItem) {
                                            statusItem.textContent = "Status: terminated";
                                        }
                                    }
                                });
                            });
                        }

                        if (message.type === "terminatedVMs") {
                            const terminatedVMs = message.terminatedVMs;
                            console.log("🛑 Removing terminated Azure VMs from UI:", terminatedVMs);

                            const vmList = document.querySelector("#vmsTable");

                            // 🔄 Remove from Azure-only table
                            terminatedVMs.forEach(vm => {
                                const vmEntries = document.querySelectorAll("#vmsTable .vm-entry");

                                vmEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".vm-id");
                                    if (idSpan && idSpan.textContent.trim() === vm.vmId) {
                                        entry.remove();
                                    }
                                });
                            });

                            // 🟪 Check if Azure VM list is now empty
                            const remainingAzureEntries = document.querySelectorAll("#vmsTable .vm-entry");
                            if (remainingAzureEntries.length === 0) {
                                const noVMItem = document.createElement("li");
                                noVMItem.id = "initialRow";
                                noVMItem.style.color = "gray";
                                noVMItem.style.listStyleType = "none";
                                noVMItem.style.textAlign = "center";
                                noVMItem.textContent = "No active VMs found.";
                                vmList.appendChild(noVMItem);
                            }

                            // 🔄 Also remove from multi-table
                            const multiEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");
                            terminatedVMs.forEach(vm => {
                                multiEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".all-instance-id");
                                    const providerItem = Array.from(entry.querySelectorAll("ul li"))
                                        .find(li => li.textContent.trim().startsWith("Provider:"));
                                    const provider = providerItem?.textContent.replace("Provider:", "").trim();

                                    if (idSpan && idSpan.textContent.trim() === vm.vmId && provider === "azure") {
                                        entry.remove();
                                    }
                                });
                            });

                            // 🟪 Show "No active instances" in multi-table if it's now empty
                            const remainingMultiEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");
                            if (remainingMultiEntries.length === 0) {
                                const noItem = document.createElement("li");
                                noItem.id = "initialRow";
                                noItem.style.color = "gray";
                                noItem.style.listStyleType = "none";
                                noItem.style.textAlign = "center";
                                noItem.textContent = "No active instances found.";
                                document.querySelector("#allinstancesTable").appendChild(noItem);
                            }
                        }

                        if (message.type === "startedResources") {
                            const startedInstances = message.startedInstances;
                            console.log("🚀 Updating status for started AWS instances:", startedInstances);

                            // 🔄 Update in AWS-specific table
                            const ec2Entries = document.querySelectorAll("#instancesTable .ec2-entry");
                            startedInstances.forEach(instanceId => {
                                ec2Entries.forEach(entry => {
                                    const idSpan = entry.querySelector(".instance-id");
                                    if (idSpan && idSpan.textContent.trim() === instanceId) {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));
                                        if (statusItem) {
                                            statusItem.textContent = "Status: running";
                                        }
                                    }
                                });
                            });

                            // 🔄 Also update in multi-table if it's present
                            const multiEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");
                            startedInstances.forEach(instanceId => {
                                multiEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".all-instance-id");
                                    const providerItem = Array.from(entry.querySelectorAll("ul li"))
                                        .find(li => li.textContent.trim().startsWith("Provider:"));
                                    const provider = providerItem?.textContent.replace("Provider:", "").trim();

                                    if (idSpan && idSpan.textContent.trim() === instanceId && provider === "aws") {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));
                                        if (statusItem) {
                                            statusItem.textContent = "Status: running";
                                        }
                                    }
                                });
                            });
                        }

                        if (message.type === "startedVMs") {
                            const startedVMs = message.startedVMs;
                            console.log("🚀 Updating status for started Azure VMs:", startedVMs);

                            // 🔄 Update in Azure-specific table
                            const vmEntries = document.querySelectorAll("#vmsTable .vm-entry");
                            startedVMs.forEach(vm => {
                                vmEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".vm-id");
                                    if (idSpan && idSpan.textContent.trim() === vm.vmId) {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));
                                        if (statusItem) {
                                            statusItem.textContent = "Status: running";
                                        }
                                    }
                                });
                            });

                            // 🔄 Also update in multi-table
                            const multiEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");
                            startedVMs.forEach(vm => {
                                multiEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".all-instance-id");
                                    const providerItem = Array.from(entry.querySelectorAll("ul li"))
                                        .find(li => li.textContent.trim().startsWith("Provider:"));
                                    const provider = providerItem?.textContent.replace("Provider:", "").trim();

                                    if (idSpan && idSpan.textContent.trim() === vm.vmId && provider === "azure") {
                                        const statusItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Status:"));
                                        if (statusItem) {
                                            statusItem.textContent = "Status: running";
                                        }
                                    }
                                });
                            });
                        }

                        if (message.type === "groupCreated") {
                            const { provider, groupname, instances, userId } = message;

                            instances.forEach(instanceId => {
                                const instanceEntries = document.querySelectorAll("#instancesTable .ec2-entry");

                                instanceEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".instance-id");

                                    if (idSpan && idSpan.textContent.trim() === instanceId) {
                                        const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Group:"));

                                        if (groupItem) {
                                            groupItem.textContent = \`Group: \${groupname}\`;
                                        }
                                    }
                                });
                            });
                        }

                        if (message.type === "groupCreatedAzure") {
                            const { provider, groupname, instances, userId } = message;
                            console.log("instances:", instances);
                            console.log("groupname:", groupname);

                            instances.forEach(({ vmId }) => {
                                const vmEntries = document.querySelectorAll("#vmsTable .vm-entry");

                                vmEntries.forEach(entry => {
                                    const idSpan = entry.querySelector(".vm-id");
                                    if (idSpan && idSpan.textContent.trim() === vmId) {
                                        console.log("reached groupCreatedAzure:", vmId);

                                        const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                            .find(li => li.textContent.trim().startsWith("Group:"));

                                        if (groupItem) {
                                            groupItem.textContent = \`Group: \${groupname}\`;
                                        }
                                    }
                                });
                            });
                        }

                        if (message.type === "multiGroupCreated") {
                            console.log("🌀 Received multiGroupCreated message:", message);

                            const groupname = message.groupname;
                            const instances = message.instances;

                            if (!instances || typeof instances !== "object") {
                                console.error("❌ No 'instances' object found in message.");
                                return;
                            }

                            const awsInstances = Array.isArray(instances.aws) ? instances.aws : [];
                            const azureInstances = Array.isArray(instances.azure) ? instances.azure : [];

                            console.log("🔹 Group name:", groupname);
                            console.log("🔹 AWS Instances:", awsInstances);
                            console.log("🔹 Azure Instances:", azureInstances);

                            const allEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");

                            allEntries.forEach(entry => {
                                const idSpan = entry.querySelector(".all-instance-id");
                                const currentId = idSpan?.textContent?.trim();

                                if (currentId && (awsInstances.includes(currentId) || azureInstances.includes(currentId))) {
                                    console.log(\`✅ Matched instance ID '\${currentId}' in combined list\`);

                                    const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                        .find(li => li.textContent.trim().startsWith("Group:"));

                                    if (groupItem) {
                                        console.log(\`✏️ Updating group name for '\${currentId}' to '\${groupname}'\`);
                                        groupItem.textContent = \`Group: \${groupname}\`;
                                    } else {
                                        console.warn(\`⚠️ Could not find group list item for instance '\${currentId}'\`);
                                    }
                                }
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
                        if (message.type === "newGroupNameAws") {
                            const groupName = message.groupName;
                            const groupSelectAws = document.getElementById("groupNameAws");

                            if (!groupSelectAws || !groupName) {
                                console.warn("⚠️ Cannot append new AWS group — missing group name or select element.");
                                return;
                            }

                            // 🔄 Remove "Waiting..." option if it's the only one
                            const firstOption = groupSelectAws.options[0];
                            if (firstOption && firstOption.value === "") {
                                groupSelectAws.removeChild(firstOption);
                            }

                            // 🚫 Prevent duplicates
                            const exists = Array.from(groupSelectAws.options).some(option => option.value === groupName);
                            if (exists) {
                                return;
                            }

                            // ➕ Append the new group
                            const option = document.createElement("option");
                            option.value = groupName;
                            option.textContent = groupName;
                            groupSelectAws.appendChild(option);

                            // ✅ Optionally select the new group
                            groupSelectAws.value = groupName;
                        }

                        if (message.type === "updateGroupsAzure") {
                            console.log("✅ Received Azure user groups:", message.azureGroups);

                            const groupSelectAzure = document.getElementById("groupNameAzure");
                            groupSelectAzure.innerHTML = ""; // Clear previous options

                            if (!message.azureGroups || message.azureGroups.length === 0) {
                                console.warn("⚠️ No Azure groups found.");
                                groupSelectAzure.innerHTML = "<option value=''>No groups found</option>";
                            } else {
                                message.azureGroups.forEach((group) => {
                                    const option = document.createElement("option");
                                    option.value = group;
                                    option.textContent = group;
                                    groupSelectAzure.appendChild(option);
                                });

                                // ✅ Select the first available group automatically
                                groupSelectAzure.value = message.azureGroups[0];
                            }
                        }
                        if (message.type === "updateMultiGroups") {
                            console.log("🌐 Received Multi-Cloud Groups:", message.multiGroups);

                            const groupSelectMulti = document.getElementById("groupNameMulti");
                            groupSelectMulti.innerHTML = ""; // Clear previous options

                            if (!message.multiGroups || message.multiGroups.length === 0) {
                                console.warn("⚠️ No multi-cloud groups found.");
                                const option = document.createElement("option");
                                option.value = "";
                                option.textContent = "No multi-cloud groups found";
                                groupSelectMulti.appendChild(option);
                            } else {
                                message.multiGroups.forEach((group) => {
                                    const option = document.createElement("option");
                                    option.value = group;
                                    option.textContent = group;
                                    groupSelectMulti.appendChild(option);
                                });

                                // ✅ Select the first group by default
                                groupSelectMulti.value = message.multiGroups[0];
                            }
                        }

                        if (message.type === "newGroupNameAzure") {
                            const groupName = message.groupName;
                            const groupSelectAzure = document.getElementById("groupNameAzure");

                            if (!groupSelectAzure || !groupName) {
                                console.warn("⚠️ Cannot append new Azure group — missing group name or select element.");
                                return;
                            }

                            // 🔄 Remove "No groups found" option if it exists
                            const firstOption = groupSelectAzure.options[0];
                            if (firstOption && firstOption.value === "") {
                                groupSelectAzure.removeChild(firstOption);
                            }

                            // 🚫 Prevent duplicates
                            const exists = Array.from(groupSelectAzure.options).some(option => option.value === groupName);
                            if (exists) {
                                return;
                            }

                            // ➕ Append the new group
                            const option = document.createElement("option");
                            option.value = groupName;
                            option.textContent = groupName;
                            groupSelectAzure.appendChild(option);

                            // ✅ Optionally select the new group
                            groupSelectAzure.value = groupName;
                        }

                        if (message.type === "newGroupNameMulti") {
                            const groupName = message.groupName;
                            const groupSelectMulti = document.getElementById("groupNameMulti");

                            if (!groupSelectMulti || !groupName) {
                                console.warn("⚠️ Cannot append new Multi group — missing group name or select element.");
                                return;
                            }

                            // 🔄 Remove "Waiting..." option if it exists
                            const firstOption = groupSelectMulti.options[0];
                            if (firstOption && firstOption.value === "") {
                                groupSelectMulti.removeChild(firstOption);
                            }

                            // 🚫 Prevent duplicates
                            const exists = Array.from(groupSelectMulti.options).some(option => option.value === groupName);
                            if (exists) {
                                return;
                            }

                            // ➕ Append the new group
                            const option = document.createElement("option");
                            option.value = groupName;
                            option.textContent = groupName;
                            groupSelectMulti.appendChild(option);

                            // ✅ Optionally select the new group
                            groupSelectMulti.value = groupName;
                        }


                        if (message.type === "groupDowntimeSet") {
                            const { provider, time, groupName, userId } = message;

                            console.log("✅ Reached message downtime set:", message);

                            const instanceEntries = document.querySelectorAll("#instancesTable .ec2-entry");

                            instanceEntries.forEach(entry => {
                                const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim() === \`Group: \${groupName}\`);

                                const shutdownItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim().startsWith("Shutdown Schedule:"));

                                if (groupItem && shutdownItem) {
                                    console.log("🔹 Start Time:", time.startTime, "| End Time:", time.endTime);
                                    shutdownItem.style.display = "none";
                                    shutdownItem.textContent = \`Shutdown Schedule: \${time.startTime} | \${time.endTime}\`;
                                }
                            });
                        }

                        if (message.type === "groupDowntimeSetAzure") {
                            const { provider, time, groupName, userId } = message;

                            console.log("✅ Reached Azure downtime set message:", message);

                            const vmEntries = document.querySelectorAll("#vmsTable .vm-entry");

                            vmEntries.forEach(entry => {
                                const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim() === \`Group: \${groupName}\`);

                                const shutdownItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim().startsWith("Shutdown Schedule:"));

                                if (groupItem && shutdownItem) {
                                    console.log("🔹 Azure VM match found. Start Time:", time.startTime, "| End Time:", time.endTime);
                                    shutdownItem.display = "none";
                                    shutdownItem.textContent = \`Shutdown Schedule:\${time.startTime} | \${time.endTime}\`;
                                }
                            });
                        }

                        if (message.type === "groupDowntimeSetMulti") {
                            const { groupName, time } = message;

                            console.log("🌐 Received multi-cloud downtime update:", message);

                            const allEntries = document.querySelectorAll("#allinstancesTable .all-instance-entry");

                            allEntries.forEach(entry => {
                                const groupItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim() === \`Group: \${groupName}\`);

                                const shutdownItem = Array.from(entry.querySelectorAll("ul li"))
                                    .find(li => li.textContent.trim().startsWith("Shutdown Schedule:"));

                                if (groupItem && shutdownItem) {
                                    console.log("🔄 Updating shutdown time for multi-cloud group entry...");
                                    shutdownItem.style.display = "none";
                                    shutdownItem.textContent = \`Shutdown Schedule: \${time.startTime} | \${time.endTime}\`;
                                }
                            });
                        }

                        if (message.type === "updateCosts") {
                            const { provider, cost, userId } = message;

                            document.getElementById("awsCost").textContent = "Month Cost: $" + cost;
                        }
                        if (message.type === "updateCostsAzure") {
                            const { provider, cost, userId } = message;

                            document.getElementById("azureCost").textContent = "Month Cost: " + cost;
                        }
                        if (message.type === "updateCombinedCost") {
                            const { totalCost } = message;

                            const costDisplay = document.getElementById("estimatedCost");
                            if (!costDisplay) {
                                console.warn("⚠️ Could not find element with ID 'estimatedCost' to display combined cost.");
                                return;
                            }

                            costDisplay.textContent = \`Total Month Cost: $\${totalCost}\`;
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

                    document.getElementById("refreshazure").addEventListener("click", () => {
                        console.log("🔄 Refresh Azure VMs button clicked");

                        // ✅ Send a message to VS Code extension
                        vscode.postMessage({
                            type: "refreshazureinstances",
                            webviewId
                        });

                        console.log("📤 Sent refreshazureinstances message");
                    });

                    document.getElementById("refreshInstances").addEventListener("click", () => {
                        console.log("🔄 Refresh All Instances button clicked");

                        vscode.postMessage({
                            type: "refreshAllInstances",
                            webviewId
                        });

                        console.log("📤 Sent refreshAllInstances message");
                    });


                    document.getElementById("submitInstanceAction").addEventListener("click", () => {
                        const selectedInstances = [];
                        console.log("🔹 Instance action requested...");

                        const selectedAction = document.getElementById("instanceAction").value;

                        // Get all checked checkboxes in the EC2 instance list
                        const checkboxes = document.querySelectorAll("#instancesTable .ec2-checkbox:checked");

                        checkboxes.forEach(checkbox => {
                            const entry = checkbox.closest(".ec2-entry");
                            const idSpan = entry.querySelector(".instance-id");
                            const instanceId = idSpan?.textContent.trim();

                            if (instanceId) {
                                selectedInstances.push(instanceId);
                            }
                        });

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

                        console.log("Sending Message from selected action", messageType);

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

                        const selectedAction = document.getElementById("instanceActionAzure").value;

                        // Get all checked checkboxes in the VM list
                        const checkboxes = document.querySelectorAll("#vmsTable .vm-checkbox:checked");

                        checkboxes.forEach(checkbox => {
                            const vmEntry = checkbox.closest(".vm-entry"); // Get parent list item

                            const vmIdSpan = vmEntry.querySelector(".vm-id");
                            const subscriptionSpan = vmEntry.querySelector(".vm-subscription");

                            const vmId = vmIdSpan?.textContent.trim();
                            const subscriptionId = subscriptionSpan?.textContent.trim();

                            if (vmId && subscriptionId) {
                                selectedVMs.push({ vmId, subscriptionId });
                            }
                        });

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
                            payload: { vms: selectedVMs }
                        });
                    });

                    document.getElementById("submitInstanceActionMulti").addEventListener("click", () => {
                        const selectedAWS = [];
                        const selectedAzure = [];
                        console.log("🌐 Multi-cloud action requested...");

                        const selectedAction = document.getElementById("instanceActionMulti").value;

                        // Get all checked checkboxes in the combined instance list
                        const checkboxes = document.querySelectorAll("#allinstancesTable .all-checkbox:checked");

                        checkboxes.forEach(checkbox => {
                            const entry = checkbox.closest(".all-instance-entry");

                            const idSpan = entry.querySelector(".all-instance-id");
                            const subSpan = entry.querySelector(".all-subscription");
                            const providerItem = Array.from(entry.querySelectorAll("ul li"))
                                .find(li => li.textContent.startsWith("Provider:"));

                            const provider = providerItem?.textContent.replace("Provider:", "").trim();
                            const instanceId = idSpan?.textContent.trim();
                            const subscriptionId = subSpan?.textContent.trim();

                            if (provider === "aws" && instanceId) {
                                selectedAWS.push(instanceId);
                            } else if (provider === "azure" && instanceId && subscriptionId) {
                                selectedAzure.push({ vmId: instanceId, subscriptionId });
                            }
                        });

                        if (selectedAWS.length === 0 && selectedAzure.length === 0) {
                            alert("⚠️ No instances selected.");
                            return;
                        }

                        let awsMessageType = "";
                        let azureMessageType = "";

                        switch (selectedAction) {
                            case "start":
                                awsMessageType = "startInstances";
                                azureMessageType = "startVMs";
                                break;
                            case "stop":
                                awsMessageType = "shutdownInstances";
                                azureMessageType = "stopVMs";
                                break;
                            case "terminate":
                                awsMessageType = "terminateInstances";
                                azureMessageType = "terminateVMs";
                                break;
                            default:
                                alert("❌ Invalid action selected.");
                                return;
                        }

                        if (selectedAWS.length > 0) {
                            console.log(\`🟦 Sending AWS \${selectedAction} request for:\`, selectedAWS);
                            vscode.postMessage({
                                type: awsMessageType,
                                provider: "aws",
                                webviewId,
                                payload: { instanceIds: selectedAWS }
                            });
                        }

                        if (selectedAzure.length > 0) {
                            console.log(\`🟪 Sending Azure \${selectedAction} request for:\`, selectedAzure);
                            vscode.postMessage({
                                type: azureMessageType,
                                provider: "azure",
                                webviewId,
                                payload: { vms: selectedAzure }
                            });
                        }
                    });

                    document.getElementById("submitGroupAction").addEventListener("click", () => {
                        const selectedInstances = [];
                        console.log("🔹 Group action requested...");

                        const selectedAction = document.getElementById("groupAction").value;

                        // Get all checked checkboxes in the instance list
                        const checkboxes = document.querySelectorAll("#instancesTable .ec2-checkbox:checked");

                        checkboxes.forEach(checkbox => {
                            const entry = checkbox.closest(".ec2-entry");
                            const idSpan = entry.querySelector(".instance-id");
                            const instanceId = idSpan?.textContent.trim();

                            if (instanceId) {
                                selectedInstances.push(instanceId);
                            }
                        });

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

                    document.getElementById("submitGroupActionAzure").addEventListener("click", () => {
                        console.log("🔹 Azure group action requested...");

                        const selectedInstances = [];

                        const selectedAction = document.getElementById("groupActionAzure").value;

                        // Get all checked checkboxes in the Azure VM list
                        const checkboxes = document.querySelectorAll("#vmsTable .vm-checkbox:checked");

                        checkboxes.forEach(checkbox => {
                            const vmEntry = checkbox.closest(".vm-entry");

                            const idSpan = vmEntry.querySelector(".vm-id");
                            const subSpan = vmEntry.querySelector(".vm-subscription");

                            const instanceId = idSpan?.textContent.trim();
                            const subscriptionId = subSpan?.textContent.trim();

                            if (instanceId && subscriptionId) {
                                selectedInstances.push({ vmId: instanceId, subscriptionId });
                            }
                        });

                        if (selectedInstances.length === 0) {
                            alert("No Azure VMs selected.");
                            return;
                        }

                        let messageType = "";
                        switch (selectedAction) {
                            case "createazure":
                                messageType = "createGroupAzure";
                                break;
                            case "addazure":
                                messageType = "addToGroupAzure";
                                break;
                            case "removeazure":
                                messageType = "removeFromGroupAzure";
                                break;
                            default:
                                alert("Invalid Azure group action selected.");
                                return;
                        }

                        // ✅ Send message to VS Code extension
                        vscode.postMessage({
                            type: messageType,
                            provider: "azure",
                            webviewId,
                            payload: { instances: selectedInstances }
                        });
                    });

                    document.getElementById("submitGroupActionMulti").addEventListener("click", () => {
                        console.log("🔹 Multi-cloud group action requested...");

                        const selectedAction = document.getElementById("groupActionMulti").value;

                        const selectedAWS = [];
                        const selectedAzure = [];

                        const checkboxes = document.querySelectorAll("#allinstancesTable .all-checkbox:checked");

                        checkboxes.forEach(checkbox => {
                            const entry = checkbox.closest(".all-instance-entry");

                            const idSpan = entry.querySelector(".all-instance-id");
                            const subSpan = entry.querySelector(".all-subscription");
                            const providerItem = Array.from(entry.querySelectorAll("ul li"))
                                .find(li => li.textContent.trim().startsWith("Provider:"));
                            const provider = providerItem?.textContent.replace("Provider:", "").trim();

                            const instanceId = idSpan?.textContent.trim();
                            const subscriptionId = subSpan?.textContent.trim();

                            if (provider === "aws" && instanceId) {
                                selectedAWS.push(instanceId);
                            } else if (provider === "azure" && instanceId && subscriptionId) {
                                selectedAzure.push({ vmId: instanceId, subscriptionId });
                            }
                        });

                        if (selectedAWS.length === 0 && selectedAzure.length === 0) {
                            alert("⚠️ No instances selected.");
                            return;
                        }

                        let messageType = "";

                        switch (selectedAction) {
                            case "create":
                                messageType = "createMultiGroup";
                                break;
                            case "add":
                                messageType = "addToMultiGroup";
                                break;
                            case "remove":
                                messageType = "removeFromMultiGroup";
                                break;
                            default:
                                alert("❌ Invalid group action selected.");
                                return;
                        }

                        vscode.postMessage({
                            type: messageType,
                            webviewId,
                            payload: {
                                aws: selectedAWS, // array of instanceIds
                                azure: selectedAzure // array of { vmId, subscriptionId }
                            }
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
                            case "deldownaws":
                                messageType = "deleteGroupDowntime";
                                break;
                            case "viewdownaws":
                                messageType = "viewGroupDowntime";
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
                    document.getElementById("submitDownActionAzure").addEventListener("click", () => {
                        console.log("🔹 Azure downtime action requested...");

                        // Get the selected group from the dropdown
                        const selectedGroup = document.getElementById("groupNameAzure").value;
                        if (!selectedGroup) {
                            alert("No group selected.");
                            return;
                        }

                        // Get the selected action from the action dropdown
                        const selectedAction = document.getElementById("groupSelectAzure").value;
                        let messageType = "";

                        switch (selectedAction) {
                            case "setdownazure":
                                messageType = "setGroupDowntime";
                                break;
                            case "deldownazure":
                                messageType = "deleteGroupDowntime";
                                break;
                            case "viewdownazure":
                                messageType = "viewGroupDowntime";
                                break;
                            default:
                                alert("Invalid action selected.");
                                return;
                        }

                        // ✅ Send message to VS Code extension
                        vscode.postMessage({
                            type: messageType,
                            provider: "azure",
                            webviewId,
                            payload: { groupName: selectedGroup }
                        });
                    });

                    document.getElementById("submitDownActionMulti").addEventListener("click", () => {
                        console.log("🔹 Multi-cloud downtime action requested...");

                        // Get the selected multi-cloud group from the dropdown
                        const selectedGroup = document.getElementById("groupNameMulti").value;
                        if (!selectedGroup) {
                            alert("No multi-cloud group selected.");
                            return;
                        }

                        // Get the selected action from the dropdown
                        const selectedAction = document.getElementById("groupSelectMulti").value;
                        let messageType = "";

                        switch (selectedAction) {
                            case "setdown":
                                messageType = "setGroupDowntimeMulti";
                                break;
                            case "deldown":
                                messageType = "deleteGroupDowntimeMulti";
                                break;
                            case "viewdown":
                                messageType = "viewGroupDowntime";
                                break;
                            default:
                                alert("Invalid multi-cloud action selected.");
                                return;
                        }

                        console.log("🔹 Sending multi-cloud downtime action:", messageType);
                        // ✅ Send message to VS Code extension
                        vscode.postMessage({
                            type: messageType,
                            provider: "both",
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
                    CloudDock
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