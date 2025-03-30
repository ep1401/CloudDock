# CloudDock: Lightweight Multicloud Test Environment Manager for VS Code

**CloudDock** empowers developers to manage test environments across **AWS** and **Azure**—all from within **Visual Studio Code**. Whether you're spinning up a quick VM, scheduling instance shutdowns, or monitoring cloud costs, CloudDock brings cloud simplicity to your IDE.

> Provision faster. Shutdown smarter. Spend less. All without leaving VS Code.

---

[!TIP] Spending too much time bouncing between AWS and Azure portals just to test your code?

CloudDock gives you one unified interface to manage both clouds, so you can stay focused on building — not babysitting infrastructure.

☁️ View the full source on GitHub: [ep1401/DevTestManager](https://github.com/ep1401/DevTestManager)

---

## 🚀 Features

### 🔁 **Multicloud Grouping**
Create multicloud environment groups and manage test setups across **AWS and Azure** together — no duplication needed.

### ⚡ **One-Click Provisioning**
Quickly launch EC2 instances or Azure VMs using built-in templates, right from VS Code.

### 🕒 **Scheduled Shutdowns**
Avoid forgotten cloud resources by scheduling shutdowns directly during provisioning.

### 🧩 **Instance Actions**
Start, stop, or terminate instances from within the **CloudDock tab** — no console hopping required.

### 💰 **Live Cost Monitoring**
View real-time cost data from both **AWS and Azure**, side-by-side, inside your IDE.

---

## 🛠️ Usage

1. Install the **CloudDock** extension from the VS Code Marketplace.
2. Authenticate with your AWS and Azure accounts.
3. **[AWS Only]** Set up the required IAM role:
   👉 [Click here to deploy the IAM Role via CloudFormation](https://us-east-2.console.aws.amazon.com/cloudformation/home?#/stacks/create/review?stackName=EC2ManagementRole&templateURL=https://my-ec2-role-templates.s3.us-east-2.amazonaws.com/iam-role-template.yaml)
4. Open the **CloudDock panel** from the sidebar.
5. Provision new instances or create multicloud groups.
6. Schedule shutdown times to avoid unnecessary costs.
7. Monitor live usage and perform instance actions from VS Code.

---

## 🧪 Example Workflow

- Launch an **Azure VM** and an **AWS EC2 instance** in one multicloud group.
- Schedule both to shut down in 2 hours to prevent billing overages.
- Use CloudDock to track cloud spend and control both environments from one place.

---

## 🧠 Built For Developers

Unlike heavy enterprise cloud management platforms, CloudDock is:

- 🪶 **Lightweight** – No complicated dashboards or governance policies
- ⚙️ **Fast** – Designed for on-demand provisioning and real-time control
- 🧑‍💻 **Developer-centric** – All within your code editor

---

## 💡 Ideal For

- Developers testing cloud-based features across providers  
- Teams that need **temporary** multicloud environments  
- Anyone tired of jumping between cloud consoles just to spin up or shut down resources

---

## 📄 License

MIT License
