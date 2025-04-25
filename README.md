# CloudDock: Multicloud Virtual Machine Environment Manager for Visual Studio Code

**CloudDock** is a lightweight extension that enables developers to manage virtual machines environments across **AWS** and **Azure**, directly within Visual Studio Code. Within the application, users can provision virtual machines, automate shutdowns, and monitor cloud usage, all without switching between cloud consoles.

> **Important:**  
> This extension was developed as part of an **Independent Work (IW)** project for **COS IW 11: Infrastructure-as-a-Service Systems for Business** under the supervision of **Professor Corey Sanders**.  
> **CloudDock is a research project prototype and is *not intended for production environments*.**
## Overview

CloudDock brings essential multicloud control directly into the development environment. By integrating AWS and Azure VM management into a single, unified interface inside Visual Studio Code, it reduces context switching, prevents unnecessary resource costs, and streamlines infrastructure management during software development and testing workflows.

While this project supports persistent background scheduling and cost visibility, **the background scheduler will only remain active as long as the VS Code environment is running**. Full production-grade deployment scenarios (such as persistent server-based scheduling) are outside the scope of this prototype.

## Installation and Setup

1. Install the **CloudDock** extension from the Visual Studio Code Marketplace.
2. Authenticate with your **AWS** and **Azure** accounts.
3. For AWS users, configure the required IAM role:  
   [Deploy via CloudFormation](https://us-east-2.console.aws.amazon.com/cloudformation/home?#/stacks/create/review?stackName=EC2ManagementRole&templateURL=https://my-ec2-role-templates.s3.us-east-2.amazonaws.com/iam-role-template.yaml)
4. Open the **CloudDock** panel from the sidebar.
5. Provision instances, schedule shutdowns, and manage environments as needed.

## Local Installation and Setup

Follow these steps to run CloudDock locally inside Visual Studio Code:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/ep1401/CloudDock.git
   cd CloudDock

2. **Install dependencies and compile the project** by running:
   ```bash
   npm install
   npm run compile

3. **Run the extension locally:**
  - Press **Control + Fn + F5**.
  - This will open a new **Extension Development Host** window.

4. **Authenticate with your cloud accounts:**
  - **AWS Users:** Configure the required IAM role using the provided CloudFormation template: [Deploy via CloudFormation](https://us-east-2.console.aws.amazon.com/cloudformation/home?#/stacks/create/review?stackName=EC2ManagementRole&templateURL=https://my-ec2-role-templates.s3.us-east-2.amazonaws.com/iam-role-template.yaml).
  - **Azure Users:** Authenticate using the Microsoft sign-in prompt through Visual Studio Code.

5. **Manage your cloud resources** directly from the CloudDock sidebar

## License

This extension is open-source and licensed under the [MIT License](LICENSE).

---

View the full source code on GitHub: [ep1401/CloudDock](https://github.com/ep1401/CloudDock)
