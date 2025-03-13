import { CancellationToken, ExtensionContext, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext, window } from "vscode";
import * as AWS from 'aws-sdk';
import * as fs from 'fs';
import * as path from 'path';

export function registerWebViewProvider(context: ExtensionContext) {
    const provider = new SidebarWebViewProvider(context.extensionUri, context);
    context.subscriptions.push(window.registerWebviewViewProvider('infinite-poc-sidebar-panel', provider));
}

export class SidebarWebViewProvider implements WebviewViewProvider {
    private userSessions: Map<string, { selectedRegion: string; instanceId: string | null; keyPairs: string[]; awsConfig?: AWS.Config }> = new Map();
    private viewInstances: Map<string, WebviewView> = new Map(); // Store Webview instances per user

    constructor(private readonly _extensionUri: Uri, public extensionContext: ExtensionContext) {}

    resolveWebviewView(webviewView: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken) {
        const userId = webviewView.webview.asWebviewUri(Uri.file('')).toString(); // Generate unique user session key
        this.viewInstances.set(userId, webviewView);

        if (!this.userSessions.has(userId)) {
            this.userSessions.set(userId, {
                selectedRegion: "us-east-2",
                instanceId: null,
                keyPairs: [],
            });
        }

        webviewView.webview.options = { enableScripts: true };

        // Load HTML content dynamically
        const connectHtml = this.getHtmlContent('connect.html');
        const awsHtml = this.getHtmlContent('aws.html');
        const azureHtml = this.getHtmlContent('azure.html');
        const multiHtml = this.getHtmlContent('multi.html');

        webviewView.webview.html = this.getHtmlForWebview(connectHtml, awsHtml, azureHtml, multiHtml);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "connectAWS":
                    await this.authenticateUser(userId);
                    break;
                case "changeRegion":
                    this.updateUserRegion(userId, data.region);
                    await this.fetchAWSKeyPairs(userId);
                    break;
                case "createAWSInstance":
                    await this.startAWSInstance(userId, data.template, data.keyPair);
                    break;
                case "stopInstance":
                    await this.stopAWSInstance(userId);
                    break;
            }
        });
    }

    private updateUserRegion(userId: string, region: string) {
        const session = this.userSessions.get(userId);
        if (session) {
            session.selectedRegion = region;
            this.userSessions.set(userId, session);
        }
    }

    private async authenticateUser(userId: string) {
        const roleArn = await this.promptForInput(
            "AWS Authentication",
            "Enter IAM Role ARN (e.g., arn:aws:iam::USER_AWS_ACCOUNT_ID:role/AllowExternalEC2Management)"
        );
    
        if (!roleArn) {
            window.showErrorMessage("IAM Role ARN is required.");
            return;
        }
    
        // ✅ Extract AWS Account ID from Role ARN
        const userAccountId = this.extractAccountId(roleArn);
        if (!userAccountId) {
            window.showErrorMessage("Invalid IAM Role ARN format. Please provide a valid ARN.");
            return;
        }
    
        try {
            console.log(`🔹 Attempting to assume IAM role: ${roleArn} for user ${userId}`);
    
            // ✅ Generate a sanitized session name
            const sanitizedSessionName = `VSCodeSession-${userId.replace(/[^a-zA-Z0-9+=,.@-]/g, '')}`;
            console.log(`🛠️ Using sanitized roleSessionName: ${sanitizedSessionName}`);
    
            const sts = new AWS.STS();
            const assumedRole = await sts.assumeRole({
                RoleArn: roleArn, // ✅ User-provided role
                RoleSessionName: sanitizedSessionName,
            }).promise();
    
            if (!assumedRole.Credentials) {
                window.showErrorMessage("Failed to assume IAM role. Please check the role permissions.");
                return;
            }
    
            // ✅ Store per-user AWS session
            const userSession = {
                awsConfig: new AWS.Config({
                    accessKeyId: assumedRole.Credentials.AccessKeyId,
                    secretAccessKey: assumedRole.Credentials.SecretAccessKey,
                    sessionToken: assumedRole.Credentials.SessionToken,
                    region: this.userSessions.get(userId)?.selectedRegion || "us-east-2",
                }),
                selectedRegion: this.userSessions.get(userId)?.selectedRegion || "us-east-2",
                instanceId: null,
                keyPairs: []
            };
    
            this.userSessions.set(userId, userSession);
            window.showInformationMessage(`✅ Successfully connected to AWS for user ${userId}`);
    
            // Fetch AWS Key Pairs & EC2 instances immediately after authentication
            await this.fetchAWSKeyPairs(userId);
            await this.fetchAllEC2Instances(userId);
    
            // Notify frontend (UI) that AWS is connected
            this.viewInstances.get(userId)?.webview.postMessage({ type: "awsConnected", userId });
    
        } catch (error) {
            console.error("❌ Error assuming IAM role:", error);
            window.showErrorMessage(`Error assuming IAM role: ${error}`);
        }
    }
    
    /**
     * ✅ Extracts AWS Account ID from a valid IAM Role ARN.
     * Example input: arn:aws:iam::123456789012:role/AllowExternalEC2Management
     * Returns: "123456789012" or null if invalid.
     */
    private extractAccountId(roleArn: string): string | null {
        const match = roleArn.match(/^arn:aws:iam::(\d+):role\/.+$/);
        return match ? match[1] : null;
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

    private async fetchAWSKeyPairs(userId: string) {
        const userSession = this.userSessions.get(userId);

        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
        
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        console.log(`🔹 Fetching AWS key pairs for user ${userId} in region: ${userSession.selectedRegion}`);
    
        // Ensure AWS SDK uses the correct region
        const ec2 = new AWS.EC2({
            region: userSession.selectedRegion, // Explicitly set region
            accessKeyId: userSession.awsConfig?.credentials?.accessKeyId,
            secretAccessKey: userSession.awsConfig?.credentials?.secretAccessKey,
            sessionToken: userSession.awsConfig?.credentials?.sessionToken
        });
    
        try {
            const result = await ec2.describeKeyPairs().promise();
            console.log(`✅ AWS Key Pairs Retrieved for user ${userId} in region ${userSession.selectedRegion}:`, result.KeyPairs);
    
            userSession.keyPairs = result.KeyPairs?.map(kp => kp.KeyName!) || [];
    
            if (userSession.keyPairs.length === 0) {
                console.warn(`⚠️ No key pairs found for user ${userId} in region ${userSession.selectedRegion}`);
                window.showWarningMessage(`No key pairs found in region ${userSession.selectedRegion}. Please create one in the AWS console.`);
            }
    
            console.log(`📤 Sending key pairs to frontend for user ${userId}:`, userSession.keyPairs);
    
            const userView = this.viewInstances.get(userId);
            if (!userView) {
                console.error(`❌ Webview not found for user ${userId}. Message cannot be sent.`);
                return;
            }
    
            userView.webview.postMessage({ type: "updateKeyPairs", keyPairs: userSession.keyPairs, userId });
            console.log(`✅ Message posted to WebView for user ${userId}`);
    
        } catch (error) {
            console.error(`❌ Error fetching key pairs for user ${userId} in region ${userSession.selectedRegion}:`, error);
            window.showErrorMessage(`Error fetching key pairs in ${userSession.selectedRegion}: ${error}`);
        }
    }    
    
    private async startAWSInstance(userId: string, template: string, keyPair: string) {
        console.log(`🔹 Starting AWS Instance for user ${userId}...`);
        console.log("Selected Template:", template);
        console.log("Selected Key Pair:", keyPair);
    
        if (!keyPair) {
            window.showErrorMessage("Please select a key pair.");
            return;
        }
    
        const userSession = this.userSessions.get(userId);

        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        const ec2 = new AWS.EC2(userSession.awsConfig);
        console.log(`🔹 Using AWS region: ${userSession.selectedRegion}`);
    
        // 🔹 Get the latest AMI for the selected region
        const latestAmi = await this.getLatestAMI(userId, template);
        if (!latestAmi) {
            window.showErrorMessage(`No suitable AMI found in region ${userSession.selectedRegion}.`);
            return;
        }
    
        // 🔹 Step 1: Find a Public Subnet in the Region
        console.log("🔍 Searching for a public subnet...");
        const subnetId = await this.findPublicSubnet(userId);
        if (!subnetId) {
            window.showErrorMessage("No public subnet found! Ensure your VPC has a public subnet.");
            return;
        }
        console.log(`✅ Found Public Subnet: ${subnetId}`);
    
        // 🔹 Step 2: Ensure a Security Group Exists that Allows SSH
        console.log("🔍 Ensuring a security group with SSH access exists...");
        const securityGroupId = await this.getOrCreateSecurityGroup(userId);
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
                    AssociatePublicIpAddress: true,
                    SubnetId: subnetId,
                    Groups: [securityGroupId]
                }
            ]
        };
    
        try {
            console.log("🔹 Sending EC2 RunInstances request...");
            const result = await ec2.runInstances(instanceParams).promise();
            console.log("✅ AWS Response:", result);
    
            if (result.Instances && result.Instances.length > 0) {
                userSession.instanceId = result.Instances[0].InstanceId ?? null;
                console.log(`📌 Instance ID for user ${userId}:`, userSession.instanceId);
    
                // ✅ Wait for instance to be in "running" state and get public IP
                const publicIp = userSession.instanceId
                    ? await this.getInstancePublicIp(userId, userSession.instanceId)
                    : null;
    
                if (publicIp) {
                    console.log("🌍 Public IP:", publicIp);
                    window.showInformationMessage(`AWS Instance Created: ${userSession.instanceId} - Public IP: ${publicIp}`);
                } else {
                    console.warn("⚠️ Instance created, but no public IP assigned yet.");
                    window.showWarningMessage(`AWS Instance Created: ${userSession.instanceId} - Waiting for public IP...`);
                }
    
                // Notify frontend about the new instance
                const userView = this.viewInstances.get(userId);
                if (userView) {
                    userView.webview.postMessage({
                        type: "instanceCreated",
                        instanceId: userSession.instanceId,
                        publicIp: publicIp || "No Public IP Yet",
                        userId
                    });
                }
            } else {
                console.error("❌ No instances returned in response:", result);
                window.showErrorMessage("Error: No instance was created. Check AWS console for issues.");
            }
        } catch (error) {
            console.error(`❌ Error launching instance for user ${userId}:`, error);
            window.showErrorMessage(`Error launching instance: ${error}`);
        }
    }    

    private async getInstancePublicIp(userId: string, instanceId: string): Promise<string | null> {
        const userSession = this.userSessions.get(userId);
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return null;
        }
    
        const ec2 = new AWS.EC2(userSession.awsConfig);
        console.log(`🔹 Fetching public IP for instance ${instanceId} (User: ${userId}) in region: ${userSession.selectedRegion}`);
    
        for (let i = 0; i < 10; i++) {  // Try up to 10 times
            try {
                const result = await ec2.describeInstances({ InstanceIds: [instanceId] }).promise();
                const instance = result.Reservations?.[0]?.Instances?.[0];
    
                if (instance?.PublicIpAddress) {
                    console.log(`✅ Public IP found for instance ${instanceId} (User: ${userId}): ${instance.PublicIpAddress}`);
                    return instance.PublicIpAddress;  // ✅ Return Public IP when found
                }
    
                console.log(`⏳ Waiting for public IP assignment... (${i + 1}/10) (User: ${userId})`);
                await new Promise(resolve => setTimeout(resolve, 3000));  // Wait 3 seconds
    
            } catch (error) {
                console.error(`❌ Error fetching instance details for user ${userId}:`, error);
                return null;
            }
        }
    
        console.warn(`⚠️ Public IP not assigned after waiting for instance ${instanceId} (User: ${userId}).`);
        return null;
    }    

    private async findPublicSubnet(userId: string): Promise<string | null> {
        const userSession = this.userSessions.get(userId);
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return null;
        }
    
        const ec2 = new AWS.EC2(userSession.awsConfig);
        console.log(`🔹 Searching for a public subnet in region ${userSession.selectedRegion} for user ${userId}`);
    
        try {
            const subnets = await ec2.describeSubnets().promise();
            for (const subnet of subnets.Subnets ?? []) {
                if (subnet.MapPublicIpOnLaunch) {
                    console.log(`✅ Found public subnet for user ${userId}: ${subnet.SubnetId}`);
                    return subnet.SubnetId!;
                }
            }
    
            console.warn(`⚠️ No public subnet found in region ${userSession.selectedRegion} for user ${userId}.`);
            return null;
        } catch (error) {
            console.error(`❌ Error finding public subnet for user ${userId}:`, error);
            return null;
        }
    }    
    
    private async getOrCreateSecurityGroup(userId: string): Promise<string> {
        const userSession = this.userSessions.get(userId);
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return "";
        }
    
        const ec2 = new AWS.EC2(userSession.awsConfig);
        const groupName = `Public-SSH-SecurityGroup-${userId}`; // Unique group per user
    
        try {
            // 🔍 Check if security group exists for this user
            const existingGroups = await ec2.describeSecurityGroups({ GroupNames: [groupName] }).promise();
            if (existingGroups.SecurityGroups && existingGroups.SecurityGroups.length > 0) {
                console.log(`✅ Security Group already exists for user ${userId}:`, existingGroups.SecurityGroups[0].GroupId);
                return existingGroups.SecurityGroups[0].GroupId!;
            }
        } catch (error) {
            console.warn(`⚠️ Security Group not found for user ${userId}, creating a new one...`);
        }
    
        try {
            // 🔹 Create a new security group
            const sgResult = await ec2.createSecurityGroup({
                GroupName: groupName,
                Description: "Allows SSH access from anywhere",
                VpcId: await this.getDefaultVpcId(ec2) // Ensure security group is created in the correct VPC
            }).promise();
    
            const securityGroupId = sgResult.GroupId!;
            console.log(`✅ Created Security Group for user ${userId}:`, securityGroupId);
    
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
    
            console.log(`✅ Security Group now allows SSH access for user ${userId}.`);
            return securityGroupId;
        } catch (error) {
            console.error(`❌ Error creating security group for user ${userId}:`, error);
            window.showErrorMessage(`Error creating security group: ${error}`);
            return "";
        }
    }
    
    // Helper function to get the default VPC ID
    private async getDefaultVpcId(ec2: AWS.EC2): Promise<string> {
        try {
            const vpcs = await ec2.describeVpcs({ Filters: [{ Name: "isDefault", Values: ["true"] }] }).promise();
            if (vpcs.Vpcs && vpcs.Vpcs.length > 0) {
                return vpcs.Vpcs[0].VpcId!;
            } else {
                throw new Error("No default VPC found.");
            }
        } catch (error) {
            console.error("❌ Error fetching default VPC:", error);
            throw new Error("Failed to retrieve default VPC.");
        }
    }    
   
    private async getLatestAMI(userId: string, template: string): Promise<string | null> {
        const userSession = this.userSessions.get(userId);
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return null;
        }
    
        const ec2 = new AWS.EC2(userSession.awsConfig);
        console.log(`🔹 Fetching latest AMI for user ${userId} in region ${userSession.selectedRegion}...`);
    
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
    
            const amiResult = await ec2.describeImages(describeImagesParams).promise();
    
            if (!amiResult.Images || amiResult.Images.length === 0) {
                console.log(`❌ No suitable AMI found for template ${template} in region ${userSession.selectedRegion}.`);
                return null;
            }
    
            // Pick the latest AMI by creation date
            const latestAmi = amiResult.Images.sort((a, b) => (b.CreationDate! > a.CreationDate! ? 1 : -1))[0].ImageId;
            console.log(`✅ Found latest AMI for user ${userId} in region ${userSession.selectedRegion}: ${latestAmi}`);
            return latestAmi ?? null;
        } catch (error) {
            console.error(`❌ Error fetching AMI for user ${userId}:`, error);
            return null;
        }
    }    
 
    private async stopAWSInstance(userId: string) {
        const userSession = this.userSessions.get(userId);

        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        if (!userSession.instanceId) {
            window.showErrorMessage("No active AWS instance to shut down.");
            return;
        }
    
        const ec2 = new AWS.EC2(userSession.awsConfig);
        console.log(`🔹 Stopping AWS instance ${userSession.instanceId} for user ${userId}...`);
    
        try {
            await ec2.terminateInstances({ InstanceIds: [userSession.instanceId] }).promise();
            console.log(`✅ AWS Instance ${userSession.instanceId} terminated for user ${userId}.`);
            
            window.showInformationMessage(`AWS Instance ${userSession.instanceId} has been terminated.`);
    
            // Notify frontend about instance termination
            const userView = this.viewInstances.get(userId);
            if (userView) {
                userView.webview.postMessage({ type: "updateStatus", status: `Instance ${userSession.instanceId} terminated`, userId });
            }
    
            userSession.instanceId = null; // Reset instance tracking for the user
        } catch (error) {
            console.error(`❌ Error stopping instance for user ${userId}:`, error);
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

    private async fetchAllEC2Instances(userId: string) {
        const userSession = this.userSessions.get(userId);

        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        console.log(`🔹 Fetching AWS EC2 instances for user ${userId} in region ${userSession.selectedRegion}...`);
    
        const ec2 = new AWS.EC2(userSession.awsConfig);
        let allInstances: { instanceId: string, instanceType: string, state: string, region: string }[] = [];
    
        try {
            const instancesData = await ec2.describeInstances().promise();
    
            allInstances = instancesData.Reservations?.flatMap(reservation =>
                reservation.Instances?.map(instance => ({
                    instanceId: instance.InstanceId ?? "N/A",
                    instanceType: instance.InstanceType ?? "Unknown",
                    state: instance.State?.Name ?? "Unknown",
                    region: userSession.selectedRegion
                })) ?? []
            ) || [];
    
            console.log(`✅ Retrieved ${allInstances.length} instances for user ${userId} in region ${userSession.selectedRegion}.`);
    
        } catch (error) {
            console.warn(`⚠️ Error retrieving instances for user ${userId}:`, error);
        }
    
        console.log(`📤 Sending instances to frontend for user ${userId}:`, allInstances);
    
        const userView = this.viewInstances.get(userId);
        if (!userView) {
            console.error(`❌ Webview not found for user ${userId}. Message cannot be sent.`);
            return;
        }
    
        userView.webview.postMessage({ type: "updateInstances", instances: allInstances, userId });
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