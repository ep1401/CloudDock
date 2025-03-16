import { CloudManager } from "./cloud/cloudManager";
import * as database from "./database/db";

class BackgroundScheduler {
    private cloudManager = CloudManager.getInstance(); // ✅ Always the same instance
    private awsManager = this.cloudManager.getAWSManager();
    private azureManager = this.cloudManager.getAzureManager();

    // ✅ Keeps track of handled groups to avoid repeated actions
    private handledGroups: Map<string, "stopped" | "started"> = new Map();

    constructor() {
        console.log("✅ Background scheduler initialized.");
        this.startMonitoring();
    }

    /**
     * 🔄 Starts the monitoring loop that checks for instance downtimes.
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
     * 🔎 Retrieves all scheduled downtimes and manages instances accordingly.
     */
    private async checkAndHandleDowntimes() {
        console.log("🔍 Checking scheduled downtimes...");

        // ✅ Get all scheduled downtimes
        const downtimes = await database.getAllGroupDowntimes();

        if (!downtimes || downtimes.length === 0) {
            console.log("⚠️ No scheduled downtimes found.");
            return;
        }

        const now = new Date();

        for (const downtime of downtimes) {
            const { groupName, startTime, endTime } = downtime;

            // ✅ Convert database timestamps to Date objects
            const start = new Date(startTime);
            const end = new Date(endTime);

            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                console.warn(`⚠️ Invalid downtime format for group '${groupName}'. Skipping...`);
                continue;
            }

            // ✅ Check instance states before taking action
            const instances = await database.getInstancesByGroup(groupName);
            const awsInstances = instances.awsInstances;
            const azureInstances = instances.azureInstances;

            // ✅ Determine action based on current time
            if (now >= start && now < end) {
                if (this.handledGroups.get(groupName) !== "stopped") {
                    console.log(`⏳ Group '${groupName}' is in scheduled downtime. Stopping instances...`);
                    await this.stopInstancesForGroup(groupName, awsInstances, azureInstances);
                    this.handledGroups.set(groupName, "stopped");
                }
            } else if (now >= end) {
                if (this.handledGroups.get(groupName) !== "started") {
                    console.log(`🚀 Group '${groupName}' downtime ended. Starting instances...`);
                    await this.startInstancesForGroup(groupName, awsInstances, azureInstances);
                    this.handledGroups.set(groupName, "started");
                }
            }
        }
    }

    /**
     * 🛑 Stops all instances in the specified group **only if running**.
     * @param groupName The name of the group whose instances should be stopped.
     */
    private async stopInstancesForGroup(groupName: string, awsInstances: any[], azureInstances: any[]) {
        // ✅ Stop AWS instances that are **currently running**
        const awsToStop = awsInstances.filter(i => i.state === "running").map(i => i.instance_id);
        if (awsToStop.length > 0) {
            console.log(`🛑 Stopping AWS instances for group '${groupName}':`, awsToStop);
            await this.awsManager.shutdownInstances(awsInstances[0].aws_id, awsToStop);
        }

        // ✅ Stop Azure instances (if implemented)
        const azureToStop = azureInstances.filter(i => i.state === "running").map(i => i.instance_id);
        if (azureToStop.length > 0) {
            console.log(`🛑 Stopping Azure instances for group '${groupName}':`, azureToStop);
            await this.azureManager.shutdownInstances(azureInstances[0].azure_id, azureToStop);
        }
    }

    /**
     * 🚀 Starts all instances in the specified group **only if stopped**.
     * @param groupName The name of the group whose instances should be started.
     */
    private async startInstancesForGroup(groupName: string, awsInstances: any[], azureInstances: any[]) {
        // ✅ Start AWS instances that are **currently stopped**
        const awsToStart = awsInstances.filter(i => i.state === "stopped").map(i => i.instance_id);
        if (awsToStart.length > 0) {
            console.log(`🚀 Starting AWS instances for group '${groupName}':`, awsToStart);
            await this.awsManager.startInstances(awsInstances[0].aws_id, awsToStart);
        }

        // ✅ Start Azure instances (if implemented)
        const azureToStart = azureInstances.filter(i => i.state === "stopped").map(i => i.instance_id);
        if (azureToStart.length > 0) {
            console.log(`🚀 Starting Azure instances for group '${groupName}':`, azureToStart);
            await this.azureManager.startInstances(azureInstances[0].azure_id, azureToStart);
        }
    }
}

// ✅ Initialize the background scheduler
const scheduler = new BackgroundScheduler();
export default scheduler;
