# CloudDock: Multicloud Test Environment Manager for Visual Studio Code

**CloudDock** is a lightweight extension that enables developers to manage test environments across **AWS** and **Azure**, directly within Visual Studio Code. Provision virtual machines, automate shutdowns, and monitor cloud usage—all without switching between cloud consoles.

## Overview

CloudDock is designed for developers who need fast, reliable control over multicloud resources during the software development lifecycle. By bringing essential cloud actions into the IDE, CloudDock reduces context switching, helps prevent resource waste, and provides greater visibility into cloud costs during testing.

The extension supports unified management of EC2 instances and Azure VMs, allowing you to group, provision, schedule, and monitor cloud resources from a single interface.

## Key Benefits

- Simplifies multicloud environment management
- Prevents unnecessary cloud spending through automated shutdowns
- Enables provisioning of AWS and Azure instances without leaving VS Code
- Provides visibility into live cloud usage and cost metrics
- Streamlines developer workflows by reducing reliance on cloud provider portals

## Installation and Setup

1. Install the **CloudDock** extension from the Visual Studio Code Marketplace.
2. Authenticate with your **AWS** and **Azure** accounts.
3. For AWS users, configure the required IAM role:  
   [Deploy via CloudFormation](https://us-east-2.console.aws.amazon.com/cloudformation/home?#/stacks/create/review?stackName=EC2ManagementRole&templateURL=https://my-ec2-role-templates.s3.us-east-2.amazonaws.com/iam-role-template.yaml)
4. Open the **CloudDock** panel from the sidebar.
5. Provision instances, schedule shutdowns, and manage environments as needed.

## Example Use Case

- Provision an Azure VM and an AWS EC2 instance as part of a test group.
- Schedule an automatic shutdown in two hours to avoid overages.
- Monitor and control both environments from within Visual Studio Code.

## Target Users

CloudDock is built specifically for:

- Developers who test applications across multiple cloud platforms
- Teams that require temporary, disposable environments for CI/CD or QA
- Users looking to streamline cloud actions without complex dashboards or governance tools

## License

This extension is open-source and licensed under the [MIT License](LICENSE).

---

View the full source code on GitHub: [ep1401/CloudDock](https://github.com/ep1401/CloudDock)
