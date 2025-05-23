# CloudDock: Multicloud Virtual Machine Environment Manager for Visual Studio (VS) Code

**CloudDock** lightweight and developer-oriented extension for VS Code that enables unified management of virtual machines across both AWS and Azure. Within the application, users can provision virtual machines, automate shutdowns, and monitor cloud usage, all without switching between cloud consoles.

> **Important:**  
> This extension was developed as part of an Independent Work (IW) project for COS IW 11: Infrastructure-as-a-Service Systems for Business under the supervision of Professor Corey Sanders.  
> **CloudDock is a research project prototype and is *not intended for production environments*.**
## Overview

CloudDock brings multicloud infrastructure control directly into the environment of the developer. By integrating AWS and Azure VM management into a single, unified interface inside VS Code, it reduces context switching, reduces unnecessary resource expense, and streamlines multicloud infrastructure management.

While this project supports persistent background scheduling and cost visibility, **the background scheduler will only remain active as long as the VS Code environment is running**. Full production grade deployment scenarios are outside the scope of this prototype.

## Installation and Setup

1. Install the CloudDock extension from the Visual Studio Code Marketplace.
2. Authenticate with your AWS and Azureaccounts.
3. For AWS users, you must configure the required IAM role found here:  
   [Deploy via CloudFormation](https://us-east-2.console.aws.amazon.com/cloudformation/home?#/stacks/create/review?stackName=EC2ManagementRole&templateURL=https://my-ec2-role-templates.s3.us-east-2.amazonaws.com/iam-role-template.yaml)
4. Open the CloudDock panel from the sidebar.

## Local Installation and Setup

Follow the steps below to run CloudDock locally:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/ep1401/CloudDock.git
   cd CloudDock

2. **Install dependencies and compile the project**:
   ```bash
   npm install
   npm run compile

3. **Run the extension locally:**
  - Press Control + Fn + F5.
  - This will open a new Extension Development Host window.

4. **Authenticate with your cloud accounts:**
  - **AWS Users:** Configure the required IAM role found here:
    [Deploy via CloudFormation](https://us-east-2.console.aws.amazon.com/cloudformation/home?#/stacks/create/review?stackName=EC2ManagementRole&templateURL=https://my-ec2-role-templates.s3.us-east-2.amazonaws.com/iam-role-template.yaml).
  - **Azure Users:** Authenticate using the Microsoft sign-in prompt through Visual Studio Code.

## License

This extension is open-source and licensed under the [MIT License](LICENSE).

---

View the full source code on GitHub: [ep1401/CloudDock](https://github.com/ep1401/CloudDock)

> **Acknowledgment:**  
> The initial setup of this extension was guided by the tutorial ["How to Create a VS Code Extension" by Code 360](https://www.youtube.com/watch?v=mBcVxsoR1vk).

