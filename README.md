# DevTest Manager (VS Code Extension)

This VS Code extension helps manage **multicloud infrastructure (AWS & Azure)** from a convenient sidebar panel. Built with **TypeScript**, **Webpack**, and custom **WebViews**.

---

## 🐳 Containerized Setup (Recommended)

### 1. Build the Docker container

```bash
docker build -t devtest-manager .
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

> **Note**  
> Edit the `.env` file and insert your actual Supabase credentials.

### 3. Start the development watcher

```bash
docker run --rm -it \
  -v ${PWD}:/app \
  -w /app \
  --env-file .env \
  devtest-manager \
  npm run watch
```

### 4. Launch the extension in VS Code

- Open the project folder in VS Code  
- Press `Ctrl + Fn + F5`  
  *or*  
- Open the **Run and Debug** tab → **Launch Extension**

---

## 🛠 Manual Setup (Without Docker)

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

> **Reminder**  
> Update `.env` with your Supabase credentials.

### 3. Start the Webpack watcher

```bash
npm run watch
```

### 4. Launch the extension

- Press `Ctrl + Fn + F5`  
  *or*  
- Use the **Run and Debug** tab → **Launch Extension**

---

## 📁 Project Structure

```
├── src/             # TypeScript source files
├── dist/            # Compiled Webpack output
├── media/           # Icons and static assets
├── .env.example     # Sample environment config
└── package.json     # Entry point: main -> dist/extension.js
```

---

## ⚙️ Features

- WebView sidebar UI for managing AWS & Azure VMs
- Multicloud group control and scheduled downtime
- Background task scheduler
- Session-specific WebViews and secret storage
- `.env`-based setup for environment separation
- Custom context menus and commands
- Output channel integration for logs

---

## 🔐 Environment Variables

To connect to Supabase, your `.env` file should include:

```env
SUPABASE_URL=your-url-here
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SECRET_KEY=your-secret-key-here
```

A sample `.env.example` file is included in the repo.

---

## 📦 Tech Stack

- `TypeScript`
- `Webpack`
- `VS Code API`
- `Supabase`
- `Docker`

---

## 🧪 Local Testing

Run all watchers and start the debugger to test live changes to your extension inside a VS Code Development Host.

---

## 📝 License

MIT License © 2025

