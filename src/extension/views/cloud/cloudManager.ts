import { AWSManager } from "./awsManager";
import { AzureManager } from "./azureManager";
import { CancellationToken, ExtensionContext, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext, window } from "vscode";
import * as database from "../database/db";

export class CloudManager {
    private awsManager = new AWSManager();
    private azureManager = new AzureManager();

    /**
     * Handles authentication for AWS or Azure.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     * @param credentials User authentication details.
     */
    async connect(provider: "aws" | "azure") {
        if (provider === "aws") {
            const roleArn = await this.promptForInput(
                "AWS Authentication",
                "Enter IAM Role ARN (e.g., arn:aws:iam::USER_AWS_ACCOUNT_ID:role/AllowExternalEC2Management)"
            );
        
            if (!roleArn) {
                window.showErrorMessage("IAM Role ARN is required.");
                return;
            }

            try {
                // Authenticate with AWS and get userAccountId
                const userAccountId: string = await this.awsManager.authenticate(roleArn);
            
                if (!userAccountId || typeof userAccountId !== "string") {
                    throw new Error("Invalid AWS Account ID received after authentication.");
                }
            
                console.log(`✅ AWS Authentication successful for account: ${userAccountId}`);
            
                // Fetch AWS Key Pairs immediately after authentication
                const keyPairs: string[] = (await this.awsManager.fetchKeyPairs(userAccountId)) || [];
            
                console.log(`🔹 Fetched AWS Key Pairs for ${userAccountId}:`, keyPairs);
            
                // ✅ Return the userAccountId and keyPairs
                return { userAccountId, keyPairs };
            
            } catch (error) {
                console.error(`❌ AWS Authentication or Key Pair retrieval failed:`, error);
                throw new Error(`AWS Authentication failed: ${error}`);
            }
            
        } else if (provider === "azure") {
            return await this.azureManager.authenticate();
        }
        throw new Error("Invalid provider specified.");
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

    /**
     * Creates an instance on AWS or Azure.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     * @param params Instance parameters.
     */
    async createInstance(provider: "aws" | "azure", userId: string, params: { keyPair?: string }) {
        if (provider === "aws") {
            return await this.awsManager.createInstance(userId, params);
        } else if (provider === "azure") {
            return "not done yet";
        }
        throw new Error("Invalid provider specified.");
    }

    /**
     * Stops an instance on AWS or Azure.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     * @param instanceId The ID of the instance to be stopped.
     */
    async stopInstance(provider: "aws" | "azure", userId: string, instanceId: string) {
        if (provider === "aws") {
            return await this.awsManager.stopInstance(userId, instanceId);
        } else if (provider === "azure") {
            return await this.azureManager.stopInstance(userId, instanceId);
        }
        throw new Error("Invalid provider specified.");
    }

    /**
     * Fetches instances associated with a user from AWS or Azure.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     */
    async fetchInstances(provider: "aws" | "azure", userId: string) {
        return "hello";
    }

    /**
     * Fetches all instance groups for AWS or Azure.
     * @param provider "aws" | "azure"
     */
    async fetchGroups(provider: "aws" | "azure") {
        return "hello";
    }

    /**
     * Assigns an instance to a group for batch shutdowns.
     * @param provider "aws" | "azure"
     * @param userId Unique ID for AWS or Azure session.
     * @param instanceId ID of the instance.
     * @param groupId ID of the group.
     */
    async assignInstanceToGroup(provider: "aws" | "azure", userId: string, instanceId: string, groupId: string) {
        return { message: `Instance ${instanceId} added to group ${groupId}` };
    }

    async changeRegion(provider: "aws" | "azure", userId: string, region: string): Promise<string[]> {
        if (provider === "aws") {
            console.log(`🔹 Changing AWS region for user ${userId} to: ${region}`);
    
            // ✅ Ensure a valid session exists before proceeding
            const keyPairs = await this.awsManager.changeRegion(userId, region);
            if (keyPairs.length === 0) {
                console.warn(`⚠️ No key pairs found after region change.`);
            }
    
            return keyPairs; // ✅ Return updated key pairs to be sent to the UI
        } 
    
        console.error(`❌ Invalid provider specified: ${provider}`);
        throw new Error("Invalid provider specified.");
    }    
}
