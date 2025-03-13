import { CancellationToken, ExtensionContext, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext, window } from "vscode";
import { CloudManager } from "./cloud/cloudManager";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid"; // Unique ID generator

export function registerWebViewProvider(context: ExtensionContext) {
    const provider = new SidebarWebViewProvider(context.extensionUri, context);
    context.subscriptions.push(window.registerWebviewViewProvider("infinite-poc-sidebar-panel", provider));
}

export class SidebarWebViewProvider implements WebviewViewProvider {
    private cloudManager: CloudManager = new CloudManager();

    // Map webview instances to their unique IDs
    private viewInstances: Map<string, WebviewView> = new Map();

    // Map webview IDs to user accounts
    private userSessions: Map<string, Record<string, string>> = new Map(); // Maps webviewId -> userId

    constructor(private readonly _extensionUri: Uri, public extensionContext: ExtensionContext) {}

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
                                     } else if (provider === "azure") {
                                        if ("subscriptions" in result && Array.isArray(result.subscriptions)) {
                                            console.log("🔑 Sending subscriptions to UI:", result.subscriptions);
                                            const { subscriptions } = result;
                                            this.postMessage(webviewId, { type: "updateSubscriptions", subscriptions, userId });
                                        }
                                        if ("resourceGroups" in result && typeof result.resourceGroups === "object") {
                                            console.log("📂 Sending resource groups to UI:", result.resourceGroups);
                                            const { resourceGroups } = result;
                                            window.showInformationMessage('Resource Groups: ' + JSON.stringify(resourceGroups));
                                            this.postMessage(webviewId, { type: "updateResourceGroups", resourceGroups, userId });
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
                        
                            // ✅ Validate required parameters
                            if (!payload || !payload.keyPair || !payload.region) {
                                console.error("❌ Missing parameters for instance creation.");
                                window.showErrorMessage("Please select a key pair and region before creating an instance.");
                                return;
                            }
                        
                            console.log(`📤 Creating ${provider.toUpperCase()} Instance for userId: ${instanceUserId} in region: ${payload.region} with key pair: ${payload.keyPair}`);
                        
                            try {
                                // ✅ Call the `cloudManager` function to create an instance with the correct user ID
                                const instanceId = await this.cloudManager.createInstance(provider, instanceUserId, {
                                    keyPair: payload.keyPair,
                                });
                        
                                if (!instanceId) {
                                    console.error("❌ Instance creation failed. No instance ID returned.");
                                    window.showErrorMessage(`Failed to create ${provider.toUpperCase()} instance. Check logs for details.`);
                                    return;
                                }
                        
                                console.log(`✅ Instance created successfully. Instance ID: ${instanceId}`);
                        
                                // ✅ Notify the webview about the created instance
                                this.postMessage(webviewId, {
                                    type: "instanceCreated",
                                    instanceId: instanceId,
                                    userId: instanceUserId,  // ✅ Send correct AWS or Azure user ID
                                });
                        
                            } catch (error) {
                                console.error(`❌ Error creating instance:`, error);
                                window.showErrorMessage(`Error creating instance: ${error}`);
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
                                row.innerHTML = \`
                                    <td><input type="checkbox" /></td>
                                    <td>\${instance.instanceId}</td>
                                    <td>\${instance.instanceType}</td>
                                    <td>\${instance.state}</td>
                                    <td>\${instance.region}</td>
                                    <td>N/A</td> <!-- Shutdown schedule placeholder -->
                                \`;
                                tableBody.appendChild(row);
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
                    });

                    document.getElementById("region").addEventListener("change", function () {
                        const region = document.getElementById("region").value;
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
                        const region = document.getElementById("region").value;

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
                    
                    document.getElementById("shutdownInstance").addEventListener("click", () => {
                        console.log("🔹 Requesting instance shutdown...");
                        
                        // Send message to extension to stop the instance
                        vscode.postMessage({ type: "stopInstance" });
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
