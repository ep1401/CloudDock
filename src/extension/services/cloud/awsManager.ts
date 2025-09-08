import * as AWS from 'aws-sdk';
import { window } from "vscode";
import * as database from "../database/db";

export class AWSManager {
   private userSessions: Map<string, { awsConfig?: AWS.Config; selectedRegion: string }> = new Map();

   /**
    *  Retrieves the stored AWS session for a user.
    * @param userAccountId AWS Account ID (which we use as the user identifier)
    * @returns The user's AWS session or undefined if not authenticated.
    */
   async getUserSession(userAccountId: string): Promise<{ awsConfig?: AWS.Config; selectedRegion: string } | undefined> {
        // Check in-memory cache
        const session = this.userSessions.get(userAccountId);
        if (session?.awsConfig) {
            return session;
        }

        // Load from DB
        const row = await database.getAWSCredentials(userAccountId);
        if (!row) {
            console.warn(`⚠️ No stored credentials found for AWS user ${userAccountId}`);
            return undefined;
        }

        const now = Date.now();
        const expiration = new Date(row.expiration).getTime();

        // If expired, try to re-authenticate
        if (expiration < now) {
            console.log(`🔁 AWS credentials expired for ${userAccountId}, re-authenticating...`);
            try {
                await this.authenticate(row.role_arn); // Should refresh session and updateUserSession
            } catch (authError) {
                console.error(`❌ Failed to re-authenticate user ${userAccountId}:`, authError);
                return undefined;
            }
        } else {
            // If still valid, create and cache awsConfig
            const awsConfig = new AWS.Config({
                accessKeyId: row.access_key_id,
                secretAccessKey: row.secret_access_key,
                sessionToken: row.session_token,
                region: row.region
            });

            this.updateUserSession(userAccountId, {
                awsConfig,
                selectedRegion: row.region
            });
        }

        // Return from memory again (freshly set)
        return this.userSessions.get(userAccountId);
    }


   /**
    * Updates or sets the AWS session for a user.
    * @param userAccountId AWS Account ID
    * @param session The updated session object
    */
   updateUserSession(userAccountId: string, session: { awsConfig?: AWS.Config; selectedRegion: string }) {
       this.userSessions.set(userAccountId, session);
   }

   /**
    * Authenticates a user with AWS.
    * @param userId Unique user identifier.
    * @param credentials AWS authentication details.
    */
   async authenticate(roleArn: string) {
       if (!roleArn) {
           window.showErrorMessage("IAM Role ARN is required.");
           throw new Error("IAM Role ARN is required.");
       }

       // Extract AWS Account ID from Role ARN (this becomes the user ID)
       const userAccountId = this.extractAccountId(roleArn);
       if (!userAccountId) {
           window.showErrorMessage("Invalid IAM Role ARN format. Please provide a valid ARN.");
           throw new Error("Invalid IAM Role ARN format.");
       }

       try {
           console.log(`🔹 Attempting to assume IAM role: ${roleArn} for AWS account ${userAccountId}`);

           // Generate a sanitized session name
           const sanitizedSessionName = `VSCodeSession-${userAccountId}`;
           console.log(`🛠️ Using sanitized roleSessionName: ${sanitizedSessionName}`);

           const sts = new AWS.STS();
           const assumedRole = await sts.assumeRole({
               RoleArn: roleArn,
               RoleSessionName: sanitizedSessionName,
           }).promise();

           if (!assumedRole.Credentials) {
               window.showErrorMessage("Failed to assume IAM role. Please check the role permissions.");
               throw new Error("Failed to assume IAM role.");
           }

           // Store per-account AWS session (using AWS Account ID as key)
           const awsConfig = new AWS.Config({
               accessKeyId: assumedRole.Credentials.AccessKeyId,
               secretAccessKey: assumedRole.Credentials.SecretAccessKey,
               sessionToken: assumedRole.Credentials.SessionToken,
               region: "us-east-2", // Default region
           });

           // Use the new helper function to store the session
           this.updateUserSession(userAccountId, { awsConfig, selectedRegion: "us-east-2" });

           await database.storeAWSCredentials({
            aws_id: userAccountId,
            access_key_id: assumedRole.Credentials.AccessKeyId!,
            secret_access_key: assumedRole.Credentials.SecretAccessKey!,
            session_token: assumedRole.Credentials.SessionToken!,
            expiration: new Date(assumedRole.Credentials.Expiration!),
            role_arn: roleArn,
            region: "us-east-2"
          });

           return userAccountId;

       } catch (error) {
           console.error("❌ Error assuming IAM role:", error);
           window.showErrorMessage(`Error assuming IAM role: ${error}`);
           throw error;
       }
   }

   /**
    * Extracts AWS Account ID from a valid IAM Role ARN.
    * Example input: arn:aws:iam::123456789012:role/AllowExternalEC2Management
    * Returns: "123456789012" or null if invalid.
    */
   private extractAccountId(roleArn: string): string | null {
       const match = roleArn.match(/^arn:aws:iam::(\d+):role\/.+$/);
       return match ? match[1] : null;
   }

    /**
     * Creates an AWS EC2 instance with a specified name.
     * @param userId Unique user identifier.
     * @param params Parameters for instance creation.
     * @param instanceName Name to assign to the instance.
     */
    async createInstance(userId: string, params: { keyPair?: string }, instanceName: string) {
        console.log(`🔹 Creating AWS Instance for user ${userId} with name "${instanceName}"...`);

        const { keyPair } = params;

        if (!keyPair) {
            window.showErrorMessage("Please select a key pair before creating an instance.");
            return;
        }

        const userSession = await this.getUserSession(userId);
        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }

        const region = userSession.selectedRegion;
        console.log(`🔹 Using AWS region: ${region}`);

        // Initialize EC2 service with correct region
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig?.credentials?.accessKeyId,
            secretAccessKey: userSession.awsConfig?.credentials?.secretAccessKey,
            sessionToken: userSession.awsConfig?.credentials?.sessionToken,
            region: region
        });

        // Get the latest AMI for the selected region
        console.log("🔍 Fetching latest AMI...");
        const latestAmi = await this.getLatestAMI(userId, "linux-postgres"); // Adjust template as needed
        if (!latestAmi) {
            window.showErrorMessage(`No suitable AMI found in region ${region}.`);
            return;
        }

        // Find a Public Subnet in the Region
        console.log("🔍 Searching for a public subnet...");
        const subnetId = await this.findPublicSubnet(userId);
        if (!subnetId) {
            window.showErrorMessage("No public subnet found! Ensure your VPC has a public subnet.");
            return;
        }
        console.log(`✅ Found Public Subnet: ${subnetId}`);

        // Ensure a Security Group Exists that Allows SSH
        console.log("🔍 Ensuring a security group with SSH access exists...");
        const securityGroupId = await this.getOrCreateSecurityGroup(userId);
        if (!securityGroupId) {
            window.showErrorMessage("Failed to create/find a security group.");
            return;
        }
        console.log(`✅ Using Security Group: ${securityGroupId}`);

        // Launch the EC2 Instance
        const instanceParams = {
            ImageId: latestAmi,
            InstanceType: "t3.micro",
            MinCount: 1,
            MaxCount: 1,
            KeyName: keyPair,
            TagSpecifications: [
                {
                    ResourceType: "instance",
                    Tags: [
                        { Key: "Name", Value: instanceName }, // Set instance name
                        { Key: "Project", Value: "DevTest" }
                    ]
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
                const instanceId = result.Instances[0].InstanceId ?? null;
                console.log(`📌 Instance ID for user ${userId}:`, instanceId);

                // Wait for instance to be in "running" state and get public IP
                const publicIp = instanceId ? await this.getInstancePublicIp(userId, instanceId) : null;

                if (publicIp) {
                    console.log("🌍 Public IP:", publicIp);
                    window.showInformationMessage(`AWS Instance Created: ${instanceId} - Public IP: ${publicIp}`);
                } else {
                    console.warn("⚠️ Instance created, but no public IP assigned yet.");
                    window.showWarningMessage(`AWS Instance Created: ${instanceId} - Waiting for public IP...`);
                }

                // Notify frontend about the new instance
                return {
                    instanceId,
                    instanceName,
                    publicIp: publicIp || "No Public IP Yet",
                    userId
                };
            } else {
                console.error("❌ No instances returned in response:", result);
                window.showErrorMessage("Error: No instance was created. Check AWS console for issues.");
            }
        } catch (error) {
            console.error(`❌ Error launching instance for user ${userId}:`, error);
            window.showErrorMessage(`Error launching instance: ${error}`);
        }
    }


   private async getLatestAMI(userId: string, template: string): Promise<string | null> {
        const userSession = await this.getUserSession(userId);

        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return null;
        }

        const region = userSession.selectedRegion;
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig?.credentials?.accessKeyId,
            secretAccessKey: userSession.awsConfig?.credentials?.secretAccessKey,
            sessionToken: userSession.awsConfig?.credentials?.sessionToken,
            region: region
        });

        console.log(`🔹 Fetching latest AMI for user ${userId} in region ${region}...`);

        // Define AMI filters based on the requested template
        let filters: AWS.EC2.Filter[];
        switch (template) {
            case "linux-postgres":
                filters = [
                    { Name: "name", Values: ["amzn2-ami-hvm-*-x86_64-gp2"] }, // Amazon Linux 2
                    { Name: "state", Values: ["available"] }
                ];
                break;

            case "ubuntu-20.04":
                filters = [
                    { Name: "name", Values: ["ubuntu/images/hvm-ssd/ubuntu-20.04-amd64-server-*"] },
                    { Name: "state", Values: ["available"] }
                ];
                break;

            case "ubuntu-22.04":
                filters = [
                    { Name: "name", Values: ["ubuntu/images/hvm-ssd/ubuntu-22.04-amd64-server-*"] },
                    { Name: "state", Values: ["available"] }
                ];
                break;

            default:
                console.error(`❌ Unsupported template: ${template}`);
                window.showErrorMessage(`Unsupported template: ${template}`);
                return null;
        }

        try {
            const describeImagesParams = {
                Owners: ["amazon"], // Only fetch AMIs owned by AWS
                Filters: filters
            };

            // Fetch AMIs matching the filters
            const amiResult = await ec2.describeImages(describeImagesParams).promise();

            if (!amiResult.Images || amiResult.Images.length === 0) {
                console.log(`❌ No suitable AMI found for template ${template} in region ${region}.`);
                return null;
            }

            // Pick the latest AMI by creation date
            const latestAmi = amiResult.Images.sort((a, b) =>
                b.CreationDate! > a.CreationDate! ? 1 : -1
            )[0].ImageId;

            console.log(`✅ Found latest AMI for user ${userId} in region ${region}: ${latestAmi}`);
            return latestAmi ?? null;
        } catch (error) {
            console.error(`❌ Error fetching AMI for user ${userId}:`, error);
            window.showErrorMessage(`Error fetching AMI: ${error}`);
            return null;
        }
    }
    
    private async findPublicSubnet(userId: string): Promise<string | null> {
        const userSession = await this.getUserSession(userId);
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return null;
        }
    
        const region = userSession.selectedRegion;
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig?.credentials?.accessKeyId,
            secretAccessKey: userSession.awsConfig?.credentials?.secretAccessKey,
            sessionToken: userSession.awsConfig?.credentials?.sessionToken,
            region: region
        });
    
        console.log(`🔹 Searching for a public subnet in region ${region} for user ${userId}...`);
    
        try {
            // Fetch all subnets in the region
            const subnets = await ec2.describeSubnets().promise();
    
            if (!subnets.Subnets || subnets.Subnets.length === 0) {
                console.warn(`⚠️ No subnets found in region ${region} for user ${userId}.`);
                return null;
            }
    
            // Filter subnets to find one that allows public IP assignment
            for (const subnet of subnets.Subnets) {
                if (subnet.MapPublicIpOnLaunch) {
                    console.log(`✅ Found public subnet for user ${userId}: ${subnet.SubnetId}`);
                    return subnet.SubnetId!;
                }
            }
    
            console.warn(`⚠️ No public subnet found in region ${region} for user ${userId}.`);
            return null;
        } catch (error) {
            console.error(`❌ Error finding public subnet for user ${userId} in region ${region}:`, error);
            window.showErrorMessage(`Error finding public subnet: ${error}`);
            return null;
        }
    }    

    private async getOrCreateSecurityGroup(userId: string): Promise<string> {
        const userSession = await this.getUserSession(userId);
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return "";
        }
    
        const region = userSession.selectedRegion;
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig?.credentials?.accessKeyId,
            secretAccessKey: userSession.awsConfig?.credentials?.secretAccessKey,
            sessionToken: userSession.awsConfig?.credentials?.sessionToken,
            region: region
        });
    
        const groupName = `Public-SSH-SecurityGroup-${userId}`; // Unique group per user
    
        try {
            // Check if the security group already exists
            const existingGroups = await ec2.describeSecurityGroups({ GroupNames: [groupName] }).promise();
            if (existingGroups.SecurityGroups && existingGroups.SecurityGroups.length > 0) {
                console.log(`✅ Security Group already exists for user ${userId}:`, existingGroups.SecurityGroups[0].GroupId);
                return existingGroups.SecurityGroups[0].GroupId!;
            }
        } catch (error) {
            console.warn(`⚠️ Security Group not found for user ${userId}, creating a new one...`);
        }
    
        try {
            // Retrieve the default VPC ID to create the security group in the correct VPC
            const vpcId = await this.getDefaultVpcId(ec2);
            if (!vpcId) {
                console.error(`❌ No default VPC found in region ${region}.`);
                window.showErrorMessage(`No default VPC found in ${region}.`);
                return "";
            }
    
            // Create a new security group
            const sgResult = await ec2.createSecurityGroup({
                GroupName: groupName,
                Description: "Allows SSH access from anywhere",
                VpcId: vpcId
            }).promise();
    
            const securityGroupId = sgResult.GroupId!;
            console.log(`✅ Created Security Group for user ${userId}: ${securityGroupId}`);
    
            // Add an inbound rule to allow SSH (Port 22) from anywhere
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
    
    /**
     * Helper function to get the default VPC ID for the region.
     */
    private async getDefaultVpcId(ec2: AWS.EC2): Promise<string> {
        try {
            const vpcs = await ec2.describeVpcs({ Filters: [{ Name: "isDefault", Values: ["true"] }] }).promise();
            if (vpcs.Vpcs && vpcs.Vpcs.length > 0) {
                console.log(`✅ Default VPC found: ${vpcs.Vpcs[0].VpcId}`);
                return vpcs.Vpcs[0].VpcId!;
            } else {
                console.warn(`⚠️ No default VPC found.`);
                return "";
            }
        } catch (error) {
            console.error("❌ Error fetching default VPC:", error);
            return "";
        }
    }    

    private async getInstancePublicIp(userId: string, instanceId: string): Promise<string | null> {
        const userSession = await this.getUserSession(userId);
    
        if (!userSession) {
            console.error(`❌ No session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return null;
        }
    
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig?.credentials?.accessKeyId,
            secretAccessKey: userSession.awsConfig?.credentials?.secretAccessKey,
            sessionToken: userSession.awsConfig?.credentials?.sessionToken,
            region: userSession.selectedRegion
        });
    
        console.log(`🔹 Fetching public IP for instance ${instanceId} (User: ${userId}) in region: ${userSession.selectedRegion}`);
    
        for (let attempt = 0; attempt < 10; attempt++) {  // Try up to 10 times
            try {
                const result = await ec2.describeInstances({ InstanceIds: [instanceId] }).promise();
                const instance = result.Reservations?.[0]?.Instances?.[0];
    
                if (instance?.PublicIpAddress) {
                    console.log(`✅ Public IP found for instance ${instanceId} (User: ${userId}): ${instance.PublicIpAddress}`);
                    return instance.PublicIpAddress;  // Return Public IP when found
                }
    
                console.log(`⏳ Waiting for public IP assignment... (${attempt + 1}/10) (User: ${userId})`);
                await new Promise(resolve => setTimeout(resolve, 3000));  // Wait 3 seconds
    
            } catch (error) {
                console.error(`❌ Error fetching instance details for user ${userId}:`, error);
                return null;
            }
        }
    
        console.warn(`⚠️ Public IP not assigned after waiting for instance ${instanceId} (User: ${userId}).`);
        return null;
    }    

   /**
    * Stops an AWS EC2 instance.
    * @param userId Unique user identifier.
    * @param instanceId The ID of the instance to be stopped.
    */
   async stopInstance(userId: string, instanceId: string) {
       // TODO: Implement AWS instance termination logic
   }

   /**
    * Fetches key pairs available to the user in the selected region.
    * @param userId Unique user identifier.
    */
   async fetchKeyPairs(userAccountId: string): Promise<string[]> {
        // Ensure session exists for the user
        const userSession = await this.getUserSession(userAccountId);
        if (!userSession || !userSession.awsConfig) {
            console.error(`❌ No valid AWS session found for account ${userAccountId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return [];
        }

        const region = userSession.selectedRegion; // Get the selected region

        console.log(`🔹 Fetching AWS key pairs for account ${userAccountId} in region: ${region}`);

        // Ensure the EC2 client uses the correct region
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig.credentials?.accessKeyId,
            secretAccessKey: userSession.awsConfig.credentials?.secretAccessKey,
            sessionToken: userSession.awsConfig.credentials?.sessionToken,
            region: region // Ensure EC2 is initialized with the selected region
        });

        try {
            // Fetch key pairs **only** for the selected region
            const result = await ec2.describeKeyPairs().promise();
            const keyPairs = result.KeyPairs?.map(kp => kp.KeyName!) || [];

            console.log(`✅ Retrieved ${keyPairs.length} key pairs for account ${userAccountId} in region ${region}`);

            // Handle case where no key pairs exist
            if (keyPairs.length === 0) {
                console.warn(`⚠️ No key pairs found for account ${userAccountId} in region ${region}`);
                window.showWarningMessage(`No key pairs found in region ${region}. Please create one in the AWS console.`);
            }

            return keyPairs;

        } catch (error) {
            console.error(`❌ Error fetching key pairs for account ${userAccountId} in region ${region}:`, error);
            window.showErrorMessage(`Error fetching key pairs in ${region}: ${error}`);
            throw error;
        }
    }

   /**
    * Retrieves all EC2 instances associated with the user.
    * @param userId Unique user identifier.
    */
   async fetchAllEC2InstancesAcrossRegions(userId: string) {
        const userSession = await this.getUserSession(userId);

        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userId}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return [];
        }

        console.log(`🔹 Fetching AWS EC2 instances for user ${userId} across multiple regions...`);

        const regions = ["us-east-2", "us-west-1", "us-west-2", "eu-west-1"];
        
        let allInstances = [];

        interface Instance {
            instanceId: string;
            instanceName: string; 
            instanceType: string;
            state: string;
            region: string;
            groupName: string | null;
            shutdownSchedule: string;
        }

        const fetchInstances = async (region: string): Promise<Instance[]> => {
            const ec2 = new AWS.EC2({
                accessKeyId: userSession.awsConfig?.credentials?.accessKeyId ?? '',
                secretAccessKey: userSession.awsConfig?.credentials?.secretAccessKey ?? '',
                sessionToken: userSession.awsConfig?.credentials?.sessionToken ?? '',
                region: region
            });

            try {
                console.log(`🔹 Fetching instances from region: ${region}`);
                const instancesData = await ec2.describeInstances().promise();

                const instances: Instance[] = instancesData.Reservations?.flatMap(reservation =>
                    reservation.Instances?.map(instance => ({
                        instanceId: instance.InstanceId ?? "N/A",
                        instanceName: instance.Tags?.find(tag => tag.Key === "Name")?.Value ?? "N/A", // ✅ Fetch instance name from Tags
                        instanceType: instance.InstanceType ?? "Unknown",
                        state: instance.State?.Name ?? "Unknown",
                        region: region,
                        groupName: null, // Placeholder for group name
                        shutdownSchedule: "N/A" // Default value
                    })) ?? []
                ) || [];

                console.log(`✅ Retrieved ${instances.length} instances from region ${region}`);
                return instances;

            } catch (error) {
                console.warn(`⚠️ Error retrieving instances from region ${region}:`, error);
                return [];
            }
        };

        const results = await Promise.all(regions.map(fetchInstances));

        // Flatten array of instance results
        allInstances = results.flat();

        console.log(`✅ Total instances retrieved for user ${userId}: ${allInstances.length}`);

        // Fetch instance groups from the database
        const instanceIds = allInstances.map(instance => instance.instanceId);
        const instanceGroups = await database.getInstanceGroups("aws", instanceIds);

        console.log("instanceGroups:", instanceGroups);

        // Fetch shutdown schedules
        const groupNames = Object.values(instanceGroups).filter(name => name !== null); // Remove null values
        const uniqueGroupNames = [...new Set(groupNames)]; // Remove duplicates

        const groupDowntimes = await Promise.all(
            uniqueGroupNames.map(async (groupName) => {
                const downtime = await database.getGroupDowntime(groupName);
                return { groupName, startTime: downtime.startTime, endTime: downtime.endTime };
            })
        );

        console.log("groupDowntimes:", groupDowntimes);

        // Convert to a lookup table
        const downtimeMap = Object.fromEntries(
            groupDowntimes.map(({ groupName, startTime, endTime }) => [groupName, `${startTime} | ${endTime}`])
        );

        console.log("groupDowntimes Map:", downtimeMap);

        // Map instance groups and shutdown schedules to instances
        allInstances = allInstances.map(instance => {
            const groupName = instanceGroups[instance.instanceId] || "N/A";
            const shutdownSchedule = groupName !== "N/A" ? (downtimeMap[groupName] !== "N/A - N/A" ? downtimeMap[groupName] : "N/A") : "N/A";

            return {
                ...instance,
                groupName,
                shutdownSchedule
            };
        });

        console.log(`✅ Updated instances with group names and shutdown schedules for user ${userId}`);

        return allInstances;
    }

   /**
    * Assigns an instance to a group for batch shutdowns.
    * @param userId Unique user identifier.
    * @param instanceId The ID of the instance.
    * @param groupId The group ID.
    */
   async assignInstanceToGroup(userId: string, instanceId: string, groupId: string) {
       // TODO: Implement instance grouping logic
   }

   /**
    * ✅ Changes AWS region and updates the session.
    * @param userAccountId AWS Account ID
    * @param region New region to set
    */
   async changeRegion(userAccountId: string, region: string): Promise<string[]> {
       console.log(`🔹 Changing AWS region for account ${userAccountId} to: ${region}`);

       // Retrieve the user session
       const userSession = await this.getUserSession(userAccountId);
       if (!userSession) {
           console.error(`❌ No active AWS session found for account ${userAccountId}.`);
           window.showErrorMessage("Please authenticate before changing regions.");
           return [];
       }

       // Update the session with the new region
       userSession.selectedRegion = region;
       this.updateUserSession(userAccountId, userSession); // Save updated session

       try {
           // Fetch key pairs for the new region
           const keyPairs: string[] = await this.fetchKeyPairs(userAccountId);

           console.log(`✅ Successfully changed AWS region to ${region} and fetched key pairs.`);
           return keyPairs;

       } catch (error) {
           console.error(`❌ Error fetching key pairs in region ${region}:`, error);
           window.showErrorMessage(`Error fetching key pairs in ${region}: ${error}`);
           return [];
       }
   }
      /**
    * Shuts down multiple AWS EC2 instances.
    * @param userIdAWS The AWS user ID.
    * @param instanceIds An array of instance IDs to be shut down.
    */
      async shutdownInstances(userIdAWS: string, instanceIds: string[]) {
        if (!userIdAWS) {
            console.error("❌ No AWS user ID provided.");
            throw new Error("AWS user ID is required to shut down instances.");
        }
    
        if (!instanceIds || instanceIds.length === 0) {
            console.error("❌ No instance IDs provided.");
            throw new Error("At least one instance ID is required to shut down instances.");
        }
    
        const userSession = await this.getUserSession(userIdAWS);
        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userIdAWS}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        const region = userSession.selectedRegion;
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig.credentials.accessKeyId,
            secretAccessKey: userSession.awsConfig.credentials.secretAccessKey,
            sessionToken: userSession.awsConfig.credentials.sessionToken,
            region: region
        });
    
        try {
            // Describe instances to get current states
            const describeResult = await ec2.describeInstances({ InstanceIds: instanceIds }).promise();
    
            const runningInstances = describeResult.Reservations?.flatMap(reservation =>
                reservation.Instances?.filter(instance =>
                    instance.State?.Name === "running"
                ).map(instance => instance.InstanceId) || []
            ) || [];
    
            if (runningInstances.length === 0) {
                console.log("⏩ No running instances to stop.");
                return;
            }
    
            console.log(`🛑 Sending stop command for running instances: ${runningInstances.join(", ")}`);
            const response = await ec2.stopInstances({ InstanceIds: runningInstances.filter(id => id !== undefined) as string[] }).promise();
    
            console.log(`✅ Shutdown initiated for instances: ${runningInstances.join(", ")}`, response);
        } catch (error) {
            console.error(`❌ Error shutting down instances for user ${userIdAWS}:`, error);
            window.showErrorMessage(`Error shutting down instances: ${error}`);
        }
    }    

    async terminateInstances(userIdAWS: string, instanceIds: string[]) {
        console.log(`🗑️ Terminating AWS instances for user ${userIdAWS}:`, instanceIds);
    
        if (!userIdAWS) {
            console.error("❌ No AWS user ID provided.");
            throw new Error("AWS user ID is required to terminate instances.");
        }
    
        if (!instanceIds || instanceIds.length === 0) {
            console.error("❌ No instance IDs provided.");
            throw new Error("At least one instance ID is required to terminate instances.");
        }
    
        // Retrieve the user session
        const userSession = await this.getUserSession(userIdAWS);
        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userIdAWS}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        const region = userSession.selectedRegion;
        console.log(`📤 Initiating termination for instances in region ${region}:`, instanceIds);
    
        // Initialize EC2 service with correct credentials
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig.credentials.accessKeyId,
            secretAccessKey: userSession.awsConfig.credentials.secretAccessKey,
            sessionToken: userSession.awsConfig.credentials.sessionToken,
            region: region
        });
    
        try {
            // Send terminate request to AWS
            const response = await ec2.terminateInstances({ InstanceIds: instanceIds }).promise();
    
            console.log(`✅ Termination initiated for instances: ${instanceIds.join(", ")}`, response);
    
        } catch (error) {
            console.error(`❌ Error terminating instances for user ${userIdAWS}:`, error);
            window.showErrorMessage(`Error terminating instances: ${error}`);
        }
    }  
    async startInstances(userIdAWS: string, instanceIds: string[]) {
        console.log(`🚀 Starting AWS instances for user ${userIdAWS}:`, instanceIds);
    
        if (!userIdAWS) {
            console.error("❌ No AWS user ID provided.");
            throw new Error("AWS user ID is required to start instances.");
        }
    
        if (!instanceIds || instanceIds.length === 0) {
            console.error("❌ No instance IDs provided.");
            throw new Error("At least one instance ID is required to start instances.");
        }
    
        const userSession = await this.getUserSession(userIdAWS);
        if (!userSession || !userSession.awsConfig?.credentials?.accessKeyId) {
            console.error(`❌ No valid AWS session found for user ${userIdAWS}. Please authenticate first.`);
            window.showErrorMessage("Please authenticate first!");
            return;
        }
    
        const region = userSession.selectedRegion;
        const ec2 = new AWS.EC2({
            accessKeyId: userSession.awsConfig.credentials.accessKeyId,
            secretAccessKey: userSession.awsConfig.credentials.secretAccessKey,
            sessionToken: userSession.awsConfig.credentials.sessionToken,
            region: region
        });
    
        try {
            // Describe instances to check their current state
            const describeResult = await ec2.describeInstances({ InstanceIds: instanceIds }).promise();
    
            const stoppedInstances = describeResult.Reservations?.flatMap(reservation =>
                reservation.Instances?.filter(instance =>
                    instance.State?.Name === "stopped"
                ).map(instance => instance.InstanceId) || []
            ) || [];
    
            if (stoppedInstances.length === 0) {
                console.log("⏩ No stopped instances to start.");
                return;
            }
    
            console.log(`🚀 Sending start command for stopped instances: ${stoppedInstances.join(", ")}`);
            const response = await ec2.startInstances({ InstanceIds: stoppedInstances.filter(id => id !== undefined) as string[] }).promise();
    
            console.log(`✅ Start initiated for instances: ${stoppedInstances.join(", ")}`, response);
    
        } catch (error) {
            console.error(`❌ Error starting instances for user ${userIdAWS}:`, error);
            window.showErrorMessage(`Error starting instances: ${error}`);
        }
    }    
    async getTotalMonthlyCost(userAccountId: string) {
        const session = await this.getUserSession(userAccountId);
        if (!session || !session.awsConfig) {
            throw new Error("User session not found. Authenticate first.");
        }
    
        // Initialize AWS Cost Explorer
        const costExplorer = new AWS.CostExplorer({
            region: "us-east-1", // Cost Explorer only runs in us-east-1
            credentials: session.awsConfig.credentials,
        });
    
        // Get the first day of the current month & today's date
        const today = new Date();
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
        const params = {
            TimePeriod: {
                Start: firstDayOfMonth.toISOString().split("T")[0], // YYYY-MM-DD
                End: today.toISOString().split("T")[0], // Today's date
            },
            Granularity: "MONTHLY", // Aggregate cost by month
            Metrics: ["UnblendedCost"], // Get total cost without amortization
        };
    
        try {
            console.log(`🔹 Fetching total AWS cost for the current month`);
    
            const response = await costExplorer.getCostAndUsage(params).promise();
    
            // Extract total cost from response
            let totalCost = 0;
            if (response.ResultsByTime && response.ResultsByTime.length > 0) {
                const amount = response.ResultsByTime[0].Total?.UnblendedCost?.Amount;
                if (amount) {
                    totalCost = parseFloat(amount);
                }
            }
    
            console.log(`✅ Total AWS Monthly Cost: $${totalCost.toFixed(2)}`);
                
            return totalCost.toFixed(2);
    
        } catch (error) {
            console.error("❌ Error retrieving AWS cost data:", error);
            window.showErrorMessage(`Error retrieving AWS cost data: ${error}`);
            throw new Error(`Failed to retrieve cost data: ${error}`);
        }
    }    
}