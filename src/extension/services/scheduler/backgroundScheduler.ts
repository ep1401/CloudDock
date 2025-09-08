import { CloudManager } from "../cloud/cloudManager";
import * as database from "../database/db";

class BackgroundScheduler {
    private cloudManager = CloudManager.getInstance(); // Always the same instance
    private awsManager = this.cloudManager.getAWSManager();
    private azureManager = this.cloudManager.getAzureManager();

    // Keeps track of handled groups to avoid repeated actions
    private handledGroups: Map<string, "stopped" | "started"> = new Map();

    constructor() {
        console.log("✅ Background scheduler initialized.");
        this.startMonitoring();
    }

    /**
     * Starts the monitoring loop that checks for instance downtimes.
     */
    private async startMonitoring() {
        console.log("⏳ Background scheduler started. Checking downtimes every minute...");

        setInterval(async () => {
            try {
                await this.checkAndHandleDowntimes();
            } catch (error) {
                console.error("❌ Error in background scheduler:", error);
            }
        }, 60 * 1000); // Run every 1 minute
    }

    /**
     * Retrieves all scheduled downtimes and manages instances accordingly.
     */
    private async checkAndHandleDowntimes() {
        console.log("🔍 Checking scheduled downtimes...");
    
        const downtimes = await database.getAllGroupDowntimes();
    
        if (!downtimes || downtimes.length === 0) {
            console.log("⚠️ No scheduled downtimes found.");
            return;
        }
    
        const now = new Date();
    
        for (const downtime of downtimes) {
            const { groupName, startTime, endTime } = downtime;
    
            const start = new Date(startTime);
            const end = new Date(endTime);
    
            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                console.warn(`⚠️ Invalid downtime format for group '${groupName}'. Skipping...`);
                continue;
            }
    
            const instances = await database.getInstancesByGroup(groupName);
            const awsInstances = instances.awsInstances;
            const azureInstances = (instances.azureInstances || []).map(i => ({
                vmId: i.instance_id,
                subscriptionId: i.sub_name,
                azure_id: i.azure_id
            }));
    
            // Check for deleted AWS/Azure instances and remove them from DB
            try {
                const awsUserId = awsInstances[0]?.aws_id;
                const azureUserId = azureInstances[0]?.azure_id;
    
                const liveAws = awsUserId ? await this.awsManager.fetchAllEC2InstancesAcrossRegions(awsUserId) : [];
                const liveAzure = azureUserId ? await this.azureManager.getUserVMs(azureUserId) : [];
    
                const liveAwsIds = new Set(liveAws.map(vm => vm.instanceId));
                const liveAzureIds = new Set(liveAzure.map(vm => vm.id));
    
                const dbAwsIds = awsInstances.map(vm => vm.instance_id);
                const dbAzureIds = azureInstances.map(vm => vm.vmId);
    
                const invalidAws = dbAwsIds.filter(id => !liveAwsIds.has(id));
                const invalidAzure = dbAzureIds.filter(id => !liveAzureIds.has(id));
    
                if (invalidAws.length > 0 || invalidAzure.length > 0) {
                    console.log("🧹 Removing deleted or invalid instances:", { invalidAws, invalidAzure });
                    await database.removeInstancesFromGroup("both", "system", {
                        aws: invalidAws,
                        azure: invalidAzure
                    });
    
                    // Remove them from memory too so they don't proceed
                    instances.awsInstances = awsInstances.filter(vm => !invalidAws.includes(vm.instance_id));
                    instances.azureInstances = azureInstances
                        .filter(vm => !invalidAzure.includes(vm.vmId))
                        .map(vm => ({
                            instance_id: vm.vmId,
                            sub_name: vm.subscriptionId,
                            azure_id: vm.azure_id
                        }));
                }
            } catch (cleanupError) {
                console.error("❌ Error cleaning up stale instances:", cleanupError);
            }
    
            // Determine action based on current time
            if (now >= start && now < end) {
                if (this.handledGroups.get(groupName) !== "stopped") {
                    console.log(`⏳ Group '${groupName}' is in scheduled downtime. Stopping instances...`);
                    await this.stopInstancesForGroup(groupName, instances.awsInstances, instances.azureInstances);
                    this.handledGroups.set(groupName, "stopped");
                }
            } else if (now >= end) {
                if (this.handledGroups.get(groupName) !== "started") {
                    console.log(`🚀 Group '${groupName}' downtime ended. Starting instances...`);
                    await this.startInstancesForGroup(groupName, instances.awsInstances, instances.azureInstances);
                    this.handledGroups.set(groupName, "started");
                }
            }
        }
    }       
    /**
     * Stops all instances in the specified group **only if running**.
     * @param groupName The name of the group whose instances should be stopped.
     */
    private async stopInstancesForGroup(groupName: string, awsInstances: any[], azureInstances: any[]) {
        if (awsInstances.length > 0) {
            const awsInstanceIds = awsInstances.map(i => i.instance_id);
            console.log(`🛑 Stopping AWS instances for group '${groupName}':`, awsInstanceIds);
            await this.awsManager.shutdownInstances(awsInstances[0].aws_id, awsInstanceIds);
        }
    
        if (azureInstances.length > 0) {
            console.log("azureInstances", azureInstances);
    
            // Correct the format
            const azureToStop = azureInstances.map(i => ({
                vmId: i.instance_id,              // ✅ map instance_id → vmId
                subscriptionId: i.sub_name        // ✅ map sub_name → subscriptionId
            }));
    
            console.log(`🛑 Stopping Azure instances for group '${groupName}':`, azureToStop);
            await this.azureManager.stopVMs(azureInstances[0].azure_id, azureToStop);
        }
    }
    

    /**
     * Starts all instances in the specified group **only if stopped**.
     * @param groupName The name of the group whose instances should be started.
     */
    private async startInstancesForGroup(groupName: string, awsInstances: any[], azureInstances: any[]) {
        // Start AWS instances that are **currently stopped**
        if (awsInstances.length > 0) {
            const awsInstanceIds: string[] = awsInstances.map(i => i.instance_id); // make sure this is a string[]
            console.log(`🚀 Starting AWS instances for group '${groupName}':`, awsInstanceIds);
            await this.awsManager.startInstances(awsInstances[0].aws_id, awsInstanceIds); // pass only string[]
        }
    
        // Start Azure instances
        if (azureInstances.length > 0) {
            // 🛠️ Map Azure instance fields correctly for startVMs
            const azureToStart = azureInstances.map(i => ({
                vmId: i.instance_id,           // Required by startVMs
                subscriptionId: i.sub_name     // Required by startVMs
            }));
    
            console.log(`🚀 Starting Azure instances for group '${groupName}':`, azureToStart);
            await this.azureManager.startVMs(azureInstances[0].azure_id, azureToStart);
        }
    }                  
}

// Initialize the background scheduler
const scheduler = new BackgroundScheduler();
export default scheduler;
