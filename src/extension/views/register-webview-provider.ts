import { CancellationToken, ExtensionContext, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext, window } from "vscode";
import * as AWS from 'aws-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from "crypto";
import { CognitoUserPool, CognitoUser, AuthenticationDetails } from "amazon-cognito-identity-js";

const CLIENT_ID = "4ca0areiglk3gubkmud0ao9tbm";  
const CLIENT_SECRET = "14bgmmteji9jco7dpdiu9u6qc4si8ntrkkt606ik2e5hc8pj2j82"; 
const IDENTITY_POOL_ID = "us-east-2:7e07eb40-6162-457f-8291-39eba80d698d"; 
const USER_POOL_ID = "us-east-2_eoQAVDbqp";

export function registerWebViewProvider(context: ExtensionContext) {
    const provider = new SidebarWebViewProvider(context.extensionUri, context);
    context.subscriptions.push(window.registerWebviewViewProvider('infinite-poc-sidebar-panel', provider));
}

function generateSecretHash(username: string, clientId: string, clientSecret: string) {
    return crypto.createHmac("sha256", clientSecret)
        .update(username + clientId)
        .digest("base64");
}

export class SidebarWebViewProvider implements WebviewViewProvider {
    private selectedRegion: string = "us-east-2"; // Default region
    isConnected: boolean = false;
    view?: WebviewView;
    private instanceId: string | null = null;
    private keyPairs: string[] = [];

    constructor(private readonly _extensionUri: Uri, public extensionContext: ExtensionContext) {}

    resolveWebviewView(webviewView: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        // Load HTML content dynamically (this does NOT change your HTML)
        const connectHtml = this.getHtmlContent('connect.html');
        const awsHtml = this.getHtmlContent('aws.html');
        const azureHtml = this.getHtmlContent('azure.html');
        const multiHtml = this.getHtmlContent('multi.html');

        webviewView.webview.html = this.getHtmlForWebview(connectHtml, awsHtml, azureHtml, multiHtml);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "connectAWS":
                    await this.authenticateUser();
                    break;
                case "changeRegion":
                    this.selectedRegion = data.region;
                    await this.fetchAWSKeyPairs();
                    break;
                case "createAWSInstance":
                    await this.startAWSInstance(data.template, data.keyPair);
                    break;
                case "stopInstance":
                    await this.stopAWSInstance();
                    break;
            }
        });        
    }

    private async authenticateUser() {
        AWS.config.update({ region: "us-east-2" }); // ✅ Ensure AWS SDK region is set
    
        const username = await this.promptForInput("AWS Authentication", "Enter your username");
        if (!username) return;
    
        const password = await this.promptForInput("AWS Authentication", "Enter your password");
        if (!password) return;
    
        const secretHash = generateSecretHash(username, CLIENT_ID, CLIENT_SECRET);
    
        const cognito = new AWS.CognitoIdentityServiceProvider();
    
        const params = {
            AuthFlow: "USER_PASSWORD_AUTH", // ✅ Ensure this is enabled in Cognito
            ClientId: CLIENT_ID,
            AuthParameters: {
                USERNAME: username,
                PASSWORD: password,
                SECRET_HASH: secretHash
            }
        };
    
        try {
            const authResponse = await cognito.initiateAuth(params).promise();
            
            const idToken = authResponse.AuthenticationResult?.IdToken;
            const accessToken = authResponse.AuthenticationResult?.AccessToken;
    
            if (!idToken || !accessToken) {
                throw new Error("Authentication failed: No tokens received.");
            }
    
            console.log("✅ Cognito Authentication Successful!");
            console.log("🔹 ID Token:", idToken);
            console.log("🔹 Access Token:", accessToken);
    
            // Store tokens in global state
            this.extensionContext.globalState.update("cognitoIdToken", idToken);
            this.extensionContext.globalState.update("cognitoAccessToken", accessToken);
    
            // ✅ Exchange Token for AWS Temporary Credentials
            await this.exchangeTokenForAWSCredentials(idToken);

            await this.fetchAWSKeyPairs();

            // 🔹 Fetch all EC2 instances after authentication
            await this.fetchAllEC2Instances();
    
            this.isConnected = true;
            window.showInformationMessage("Successfully connected to AWS!");
            this.view?.webview.postMessage({ type: "awsConnected" });
        } catch (error) {
            console.error("❌ Cognito Authentication Failed:", error);
            window.showErrorMessage("Authentication failed: " + error);
        }
    }    

    private async exchangeTokenForAWSCredentials(idToken: string) {
        const identityPoolId = "us-east-2:7e07eb40-6162-457f-8291-39eba80d698d"; 
    
        AWS.config.region = "us-east-2";  // ✅ Set your region
    
        AWS.config.credentials = new AWS.CognitoIdentityCredentials({
            IdentityPoolId: identityPoolId,
            Logins: {
                [`cognito-idp.us-east-2.amazonaws.com/us-east-2_eoQAVDbqp`]: idToken
            }
        });
    
        try {
            await (AWS.config.credentials as AWS.CognitoIdentityCredentials).getPromise();
            console.log("✅ AWS Temporary Credentials Acquired:", AWS.config.credentials);
        } catch (error) {
            console.error("❌ Error exchanging token for AWS credentials:", error);
        }
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

    private async fetchAWSKeyPairs() {
        console.log(`🔹 Fetching AWS key pairs for region: ${this.selectedRegion}`);
        
        const accessKey = this.extensionContext.globalState.get<string>("awsAccessKey");
        const secretKey = this.extensionContext.globalState.get<string>("awsSecretKey");
    
        if (!accessKey || !secretKey) {
            console.error("❌ AWS credentials missing!");
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        AWS.config.update({ accessKeyId: accessKey, secretAccessKey: secretKey, region: this.selectedRegion });
        const ec2 = new AWS.EC2();
    
        try {
            const result = await ec2.describeKeyPairs().promise();
            console.log("✅ AWS Key Pairs Retrieved:", result.KeyPairs);
    
            this.keyPairs = result.KeyPairs?.map(kp => kp.KeyName!) || [];
    
            if (this.keyPairs.length === 0) {
                console.warn("⚠️ No key pairs found in region:", this.selectedRegion);
                window.showWarningMessage("No key pairs found in this region. Please create one in the AWS console.");
            }
    
            console.log("📤 Sending key pairs to frontend:", this.keyPairs);
    
            // 🔹 Ensure Webview exists before sending message
            if (!this.view) {
                console.error("❌ Webview is undefined! Message cannot be sent.");
                return;
            }
    
            this.view.webview.postMessage({ type: "updateKeyPairs", keyPairs: this.keyPairs });
            console.log("✅ Message posted to Webview!");
    
            window.showInformationMessage("Sent message");
    
        } catch (error) {
            console.error("❌ Error fetching key pairs:", error);
            window.showErrorMessage(`Error fetching key pairs: ${error}`);
        }
    }
    
 
    private async startAWSInstance(template: string, keyPair: string) {
        console.log("🔹 Starting AWS Instance...");
        console.log("Selected Template:", template);
        console.log("Selected Key Pair:", keyPair);
        console.log("Selected Region:", this.selectedRegion);
    
        if (!keyPair) {
            window.showErrorMessage("Please select a key pair.");
            return;
        }
    
        const accessKey = this.extensionContext.globalState.get<string>("awsAccessKey");
        const secretKey = this.extensionContext.globalState.get<string>("awsSecretKey");
    
        if (!accessKey || !secretKey) {
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        AWS.config.update({
            accessKeyId: accessKey,
            secretAccessKey: secretKey,
            region: this.selectedRegion
        });
    
        const ec2 = new AWS.EC2();
    
        // 🔹 Get the latest AMI for the selected region
        const latestAmi = await this.getLatestAMI(template);
        if (!latestAmi) {
            window.showErrorMessage(`No suitable AMI found in region ${this.selectedRegion}.`);
            return;
        }
    
        // 🔹 Step 1: Find a Public Subnet in the Region
        console.log("🔍 Searching for a public subnet...");
        const subnetId = await this.findPublicSubnet(ec2);
        if (!subnetId) {
            window.showErrorMessage("No public subnet found! Ensure your VPC has a public subnet.");
            return;
        }
        console.log(`✅ Found Public Subnet: ${subnetId}`);
    
        // 🔹 Step 2: Ensure a Security Group Exists that Allows SSH
        console.log("🔍 Ensuring a security group with SSH access exists...");
        const securityGroupId = await this.getOrCreateSecurityGroup(ec2);
        console.log(`✅ Using Security Group: ${securityGroupId}`);
    
        // 🔹 Step 3: Launch the EC2 Instance
        const instanceParams = {
            ImageId: latestAmi,
            InstanceType: "t3.micro",
            MinCount: 1,
            MaxCount: 1,
            KeyName: keyPair,
            TagSpecifications: [
                {
                    ResourceType: "instance",
                    Tags: [{ Key: "Project", Value: "DevTest" }]
                }
            ],
            NetworkInterfaces: [
                {
                    DeviceIndex: 0,
                    AssociatePublicIpAddress: true,  // ✅ Ensures the instance gets a public IP
                    SubnetId: subnetId,  // ✅ Places instance in a public subnet
                    Groups: [securityGroupId]  // ✅ Moves Security Groups here
                }
            ]
        };        
    
        try {
            console.log("🔹 Sending EC2 RunInstances request...");
            const result = await ec2.runInstances(instanceParams).promise();
            console.log("✅ AWS Response:", result);
        
            if (result.Instances && result.Instances.length > 0) {
                this.instanceId = result.Instances[0].InstanceId ?? null;
        
                console.log("📌 Instance ID:", this.instanceId);
        
                // ✅ NEW: Wait for instance to be in "running" state and get public IP
                const publicIp = this.instanceId ? await this.getInstancePublicIp(this.instanceId) : null;
        
                if (publicIp) {
                    console.log("🌍 Public IP:", publicIp);
                    window.showInformationMessage(`AWS Instance Created: ${this.instanceId} - Public IP: ${publicIp}`);
                } else {
                    console.warn("⚠️ Instance created, but no public IP assigned yet.");
                    window.showWarningMessage(`AWS Instance Created: ${this.instanceId} - Waiting for public IP...`);
                }
        
                // Notify frontend (aws.html) about the new instance
                this.view?.webview.postMessage({
                    type: "instanceCreated",
                    instanceId: this.instanceId,
                    publicIp: publicIp || "No Public IP Yet"
                });
            } else {
                console.error("❌ No instances returned in response:", result);
                window.showErrorMessage("Error: No instance was created. Check AWS console for issues.");
            }
        } catch (error) {
            console.error("❌ Error launching instance:", error);
            window.showErrorMessage(`Error launching instance: ${error}`);
        }
    }

    private async getInstancePublicIp(instanceId: string): Promise<string | null> {
        const ec2 = new AWS.EC2();
        
        for (let i = 0; i < 10; i++) {  // Try up to 10 times
            try {
                const result = await ec2.describeInstances({ InstanceIds: [instanceId] }).promise();
                const instance = result.Reservations?.[0]?.Instances?.[0];
    
                if (instance?.PublicIpAddress) {
                    return instance.PublicIpAddress;  // ✅ Return Public IP when found
                }
    
                console.log(`⏳ Waiting for public IP assignment... (${i + 1}/10)`);
                await new Promise(resolve => setTimeout(resolve, 3000));  // Wait 3 seconds
            } catch (error) {
                console.error("❌ Error fetching instance details:", error);
                return null;
            }
        }
    
        console.warn("⚠️ Public IP not assigned after waiting.");
        return null;
    }    

    private async findPublicSubnet(ec2: AWS.EC2): Promise<string | null> {
        try {
            const subnets = await ec2.describeSubnets().promise();
            for (const subnet of subnets.Subnets ?? []) {
                if (subnet.MapPublicIpOnLaunch) {
                    return subnet.SubnetId!;
                }
            }
            console.warn("⚠️ No public subnet found.");
            return null;
        } catch (error) {
            console.error("❌ Error finding public subnet:", error);
            return null;
        }
    }
    
    private async getOrCreateSecurityGroup(ec2: AWS.EC2): Promise<string> {
        const groupName = "Public-SSH-SecurityGroup";
    
        try {
            // 🔍 Check if security group exists
            const existingGroups = await ec2.describeSecurityGroups({ GroupNames: [groupName] }).promise();
            if (existingGroups.SecurityGroups && existingGroups.SecurityGroups.length > 0) {
                console.log("✅ Security Group already exists:", existingGroups.SecurityGroups[0].GroupId);
                return existingGroups.SecurityGroups[0].GroupId!;
            }
        } catch (error) {
            console.warn("⚠️ Security Group not found, creating a new one...");
        }
    
        // 🔹 Create a new security group
        const sgResult = await ec2.createSecurityGroup({
            GroupName: groupName,
            Description: "Allows SSH access from anywhere"
        }).promise();
    
        const securityGroupId = sgResult.GroupId!;
        console.log("✅ Created Security Group:", securityGroupId);
    
        // 🔹 Add an inbound rule to allow SSH (Port 22) from anywhere
        await ec2.authorizeSecurityGroupIngress({
            GroupId: securityGroupId,
            IpPermissions: [
                {
                    IpProtocol: "tcp",
                    FromPort: 22,
                    ToPort: 22,
                    IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "Allow SSH from anywhere" }]
                }
            ]
        }).promise();
    
        console.log("✅ Security Group now allows SSH access.");
        return securityGroupId;
    }       
   
    private async getLatestAMI(template: string): Promise<string | null> {
        const ec2 = new AWS.EC2();
   
        try {
            const describeImagesParams = {
                Owners: ["amazon"],
                Filters: [
                    {
                        Name: "name",
                        Values: template === "linux-postgres"
                            ? ["amzn2-ami-hvm-*-x86_64-gp2"] // Amazon Linux 2
                            : ["ubuntu/images/hvm-ssd/ubuntu-20.04-amd64-server-*"] // Ubuntu 20.04
                    },
                    { Name: "state", Values: ["available"] }
                ]
            };
   
            console.log(`🔹 Fetching AMI for region ${this.selectedRegion}...`);
            const amiResult = await ec2.describeImages(describeImagesParams).promise();
   
            if (!amiResult.Images || amiResult.Images.length === 0) {
                console.log(`❌ No suitable AMI found for ${template} in ${this.selectedRegion}.`);
                return null;
            }
   
            // Pick the latest AMI by creation date
            const latestAmi = amiResult.Images.sort((a, b) => (b.CreationDate! > a.CreationDate! ? 1 : -1))[0].ImageId;
            console.log(`✅ Found AMI: ${latestAmi} for ${this.selectedRegion}`);
            return latestAmi ?? null;
        } catch (error) {
            console.error("❌ Error fetching AMI:", error);
            return null;
        }
    } 
 
    private async stopAWSInstance() {
        if (!this.instanceId) {
            window.showErrorMessage("No active AWS instance to shut down.");
            return;
        }
 
 
        const accessKey = this.extensionContext.globalState.get("awsAccessKey");
        const secretKey = this.extensionContext.globalState.get("awsSecretKey");
 
 
        if (!accessKey || !secretKey) {
            window.showErrorMessage("Please authenticate first!");
            return;
        }
 
 
        AWS.config.update({ accessKeyId: accessKey as string, secretAccessKey: secretKey as string, region: this.selectedRegion });
        const ec2 = new AWS.EC2();
 
 
        try {
            await ec2.terminateInstances({ InstanceIds: [this.instanceId] }).promise();
            window.showInformationMessage(`AWS Instance ${this.instanceId} has been terminated.`);
            this.view?.webview.postMessage({ type: "updateStatus", status: `Instance ${this.instanceId} terminated` });
            this.instanceId = null;
        } catch (error) {
            window.showErrorMessage(`Error stopping instance: ${error}`);
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

    private async fetchAllEC2Instances() {
        console.log("🔹 Fetching AWS EC2 instances from selected regions...");
    
        const accessKey = this.extensionContext.globalState.get<string>("awsAccessKey");
        const secretKey = this.extensionContext.globalState.get<string>("awsSecretKey");
    
        if (!accessKey || !secretKey) {
            console.error("❌ AWS credentials missing!");
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        // ✅ Only these regions will be checked
        const selectedRegions = ["us-east-2", "us-west-1", "us-west-2", "eu-west-1"];
    
        AWS.config.update({ accessKeyId: accessKey, secretAccessKey: secretKey });
    
        let allInstances: { instanceId: string, instanceType: string, state: string, region: string }[] = [];
    
        for (const region of selectedRegions) {
            try {
                AWS.config.update({ region });
                const ec2Region = new AWS.EC2();
                const instancesData = await ec2Region.describeInstances().promise();
    
                const regionInstances = instancesData.Reservations?.flatMap(reservation =>
                    reservation.Instances?.map(instance => ({
                        instanceId: instance.InstanceId ?? "N/A",
                        instanceType: instance.InstanceType ?? "Unknown",
                        state: instance.State?.Name ?? "Unknown",
                        region
                    })) ?? []
                ) || [];
    
                console.log(`✅ Retrieved ${regionInstances.length} instances from ${region}`);
                allInstances = [...allInstances, ...regionInstances];
    
            } catch (error) {
                console.warn(`⚠️ Error retrieving instances from ${region}:`, error);
            }
        }
    
        console.log("📤 Sending all instances to frontend:", allInstances);
    
        // 🔹 Ensure Webview exists before sending message
        if (!this.view) {
            console.error("❌ Webview is undefined! Message cannot be sent.");
            return;
        }
    
        this.view.webview.postMessage({ type: "updateInstances", instances: allInstances });
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

                window.addEventListener("DOMContentLoaded", () => {
                    document.getElementById("connectAWS").addEventListener("click", function() {
                        const awsStatusElement = document.getElementById("awsStatus");
                        awsStatusElement.textContent = "AWS Status: Connecting...";
                        awsStatusElement.className = "status-text connecting";

                        vscode.postMessage({ type: "connectAWS" });
                    });

                    window.addEventListener("message", event => {
                        const message = event.data;
                        if (message.type === "awsConnected") {
                            document.getElementById("awsStatus").textContent = "AWS Status: Connected";
                            document.getElementById("awsStatus").className = "status-text connected";
                            document.getElementById("status").textContent = "AWS Status: Connected";
                            document.getElementById("status").className = "status-text connected";
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
                    });

                    document.getElementById("region").addEventListener("change", function () {
                        const region = document.getElementById("region").value;
                        console.log("🔹 Region changed to:", region);
                
                        // Show "Fetching..." while waiting for the response
                        const keyPairSelect = document.getElementById("keyPair");
                        keyPairSelect.innerHTML = "<option value=''>Fetching key pairs...</option>";
                
                        vscode.postMessage({ type: "changeRegion", region });
                    });

                    document.getElementById("createInstance").addEventListener("click", () => {
                        const keyPair = document.getElementById("keyPair").value;
                        const region = document.getElementById("region").value;

                        if (!keyPair) {
                            alert("Please select a key pair before creating an instance.");
                            return;
                        }
                        
                        // Send message to extension to create an AWS instance
                        vscode.postMessage({ type: "createAWSInstance", template: "linux-postgres", keyPair });
                    });
                    
                    document.getElementById("shutdownInstance").addEventListener("click", () => {
                        console.log("🔹 Requesting instance shutdown...");
                        
                        // Send message to extension to stop the instance
                        vscode.postMessage({ type: "stopInstance" });
                    });
                });
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
