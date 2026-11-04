# Local Tunnel MCP

[简体中文](README.md) | English

Let AI agents on your server work directly on your local machines: read and edit code, search files, and run commands.

Connect all your computers to one server and it becomes your control center: work on different projects across different machines from a single AI session.

## Use cases

- **AI on the server, code on your machine:** Keep Claude Code or Codex always on a server while your code and development environment stay on your own computer, with nothing to sync.
- **Manage several computers in one place:** Connect your work computer, home computer and Mac to the same server, then tell the AI which one to use.
- **Work across machines:** Compare configuration between two computers, carry a change from one to the other, or build on Windows and verify on a Mac.
- **Work from your phone:** As long as you can reach the server, the AI can change code and run tests on your computer at home.
- **Show the AI local content:** Point it at logs, documents and screenshots instead of copying and pasting them.

## Install

Download the package for your system from [Releases](https://github.com/PLZY/local-tunnel-mcp/releases/latest). The runtime is included, so you do not need to install Node.js.

The packages are not code-signed, so your system will show a security warning. Follow the steps below to allow the app.

### Windows

1. Download `LocalTunnel-Setup-x.x.x.exe` and double-click it.
2. If you see "Windows protected your PC", click **More info**, then **Run anyway**.
3. After installing, open Local Tunnel from the Start menu.
4. Install PowerShell 7, which the AI needs to run commands:

   ```powershell
   winget install --id Microsoft.PowerShell
   ```

### macOS

1. Download the package for your chip: `LocalTunnel-x.x.x-arm64.dmg` for Apple silicon, or `LocalTunnel-x.x.x-x64.dmg` for Intel.
2. Open the dmg and drag LocalTunnel to the Applications folder.
3. Open Terminal and run:

   ```bash
   xattr -cr /Applications/LocalTunnel.app
   ```

4. Open LocalTunnel from the Applications folder.

Without step 3, macOS may say the app "is damaged and can't be opened" or that the developer cannot be verified. The file is not actually damaged. macOS is blocking an unsigned app, and step 3 lets it open normally.

## Usage

The console is currently available in Chinese only. The steps below give each label in both languages.

**1. Connect to your server**

The console opens in your browser when you start the app. Enter the server address (服务器地址), your login details and the folders the AI may access (允许 AI 访问的目录), then turn on **Enable remote access (开启远程访问)**. Confirm that you trust the server the first time you connect.

**2. Connect your AI tool**

Click **Copy MCP config (复制 MCP 配置)** and add the config to the AI tool on your server.

**3. Describe what you need**

> Fix this bug on home-mac and run the tests
>
> Look at the latest screenshot in the downloads folder on windows-pc

For more computers, repeat these steps on each one and give each a different server forwarding port (服务器转发端口).

To make the tools easier for the AI to use, you can add the prompt from [本机文件访问提示词.md](本机文件访问提示词.md) (in Chinese) to `CLAUDE.md` or `AGENTS.md` in your server project.

**Quit**

Closing the browser page does not disconnect anything, and the AI can still reach your computer.

- **Windows:** Right-click the tray icon near the clock and choose **Quit (退出)**.
- **macOS:** Right-click the Dock icon and choose **Quit**, or press `Cmd+Q`.

## Features

- **Files:** Browse folders and read, edit or create files. Large files stay fast.
- **Search:** Find files by name or content, with regular expressions.
- **Commands:** Run builds, tests, git and other commands locally.
- **Images:** Let the AI view local screenshots and images.
- **Multiple devices:** Connect many computers to one server, or one computer to many servers. The target device is checked before every operation.
- **Connection management:** Configure everything in a web console, sign in with a key or password, and reconnect automatically.
- **No server changes:** Nothing to deploy on the server, and no new public ports to open.

## Security

Once enabled, the AI can act on this computer with your user permissions. Only connect to servers you trust, keep the Token in your connection config safe, and do not expose the forwarding port to the public internet.

## Development

Requires Node.js 22 or later.

```bash
npm ci
npm test
npm start
```

## License

This project is for learning and exchange only. **Commercial use is prohibited.** See [LICENSE](LICENSE).
