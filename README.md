# Hearth

A desktop app for Windows that puts a polished interface on [Ollama](https://ollama.com), so local models can be used without a terminal. Everything Hearth itself does with AI runs on your own hardware. A separate, clearly marked **Cloud AI** tab puts Claude, ChatGPT and Gemini side by side for the times you want them.

## What it does

**Hearth tab (local)**

- **Chat** with any installed model, with streaming replies, "thinking" display, Markdown and code highlighting.
- **Projects** — each has its own chats, instructions and an optional linked folder.
- **Files** — browse the project folder, open files in tabs, edit and save, and attach files to a chat as context. Create, rename, move and delete from the tree.
- **Models** — switch models from a picker, see what is installed and loaded, search the Ollama library and Hugging Face, and download with progress and a "will it fit this PC" hint.
- **File tools for the model** — the model can list and read project files on its own, and can *ask* to create, edit, move or delete them. Every change is shown first (edits as a before/after comparison) and happens only when you press **Allow**.
- **GitHub** — sign in from inside the app and upload a project to a new repository in your own account (private by default), or push later changes, with one button.

**Cloud AI tab (not local)**

- Claude, ChatGPT and Gemini as three side-by-side panes in the same window, so you can use whichever suits the task.
- The panes are the companies' own websites, where you sign in with your own accounts. They do not talk to each other or to the Hearth tab; nothing is passed between them.
- This is the only part of Hearth that involves cloud AI. The Hearth tab still blocks cloud models.

## Requirements

- Windows 10 or 11 (uses the built-in .NET Framework 4.8 and Microsoft Edge)
- [Ollama](https://ollama.com/download) installed
- For the tabbed window with the Cloud AI tab: the Microsoft Edge WebView2 runtime, which ships with Windows 11
- [Git for Windows](https://git-scm.com/download/win) and the [GitHub CLI](https://cli.github.com/), only if you want to upload projects to GitHub

No SDKs or package managers are needed. The one bundled third-party component is Microsoft's WebView2 (`tools\webview2`, unmodified and Microsoft-signed), used only by the tabbed window.

## Running Hearth

### 1. Download it

1. On the repository page, press **Code**, then **Download ZIP**.
2. Extract the zip to a folder you will keep, for example `Documents\Hearth`.

That is all. The folder already contains `Hearth.exe`; nothing needs installing or building.

### 2. Start it

**Double-click `Open Hearth`** in the folder (it shows as `Open Hearth.cmd` if Windows is set to show file extensions). One window opens with two tabs at the top: **Hearth** and **Cloud AI**.

Hearth is not code-signed, so Windows may object the first time:

- **"Windows protected your PC".** Choose **More info**, then **Run anyway**.
- **Smart App Control blocks it.** On PCs where that Windows feature is switched on there is no "run anyway". Delete the extracted folder, right-click the downloaded zip, choose **Properties**, tick **Unblock**, press **OK**, and extract it again. That tells Windows you trust this download. Windows may still refuse `Hearth.exe` itself; see the table under "If something goes wrong".

Keep the folder together: `Open Hearth` needs `Hearth.exe` and the `tools` folder beside it.

To also have Hearth on the Start menu, run this once in PowerShell from the folder:

```powershell
powershell -ExecutionPolicy Bypass -File tools\hearth-window.ps1 -InstallShortcut
```

**Local only, without the Cloud AI tab.** Double-click `Hearth.exe` itself. It opens the same Hearth interface in its own window, with no Cloud AI tab, and needs nothing else beside it.
Either way:

- Starting Hearth again while it is open opens another window onto the same session.
- Closing the last window shuts Hearth's local service down a few seconds later. Nothing keeps running in the background.

### 3. First use

1. **Ollama.** If a banner says Ollama is not running, press **Start Ollama** on it.
2. **Get a model.** Open **Models** (bottom left) → **Discover**, search, expand a model and press **Download** on a version. The badge next to each version says whether it fits this PC's GPU.
3. **Chat.** Pick the model from the picker at the top right and type in the box at the bottom. Enter sends, Shift+Enter makes a new line.
4. **Work with files (optional).** Use the project switcher at the top left → **New project…** and choose a folder. Its files appear under the **Files** tab; open one and press **Add to chat** to give it to the model. With **File tools** switched on in the message box, the model can also read files and ask to change them; each change waits for your **Allow**.
5. **GitHub (optional).** Press **GitHub** at the bottom left to sign in and upload the current project.

### Using the Cloud AI tab

Click **Cloud AI** at the top of the window. Three panes open side by side, by default Claude, ChatGPT and Gemini.

- **Sign in** in each pane with your normal account for that site. Sign-ins are remembered between sessions.
- **Each pane** has a site picker, so any pane can show any of the three sites, plus **Back**, **Reload** and **Home**. Drag the dividers to resize the panes.
- **What it can reach:** only those three sites and the sign-in services they use (Google, Apple and Microsoft sign-in, and the "are you human" checks). Any other address fails to load, including links inside those sites that lead elsewhere.
- **What leaves this PC:** whatever you type or paste into a pane goes to that company, exactly as it would in a normal browser. Nothing from the Hearth tab is shared with the panes.
- **Nothing loads until you open the tab** for the first time in a session.

If a site will not let you sign in inside a pane (some sign-in pages refuse embedded browsers), use the fallback: `tools\cloud-windows.ps1` opens the same sites, with the same restriction, as up to three separate Microsoft Edge windows tiled side by side.

```powershell
powershell -ExecutionPolicy Bypass -File tools\cloud-windows.ps1
```

### Where your data lives

Everything Hearth stores is under `%LOCALAPPDATA%\Hearth`:

| Folder or file | What it holds |
| --- | --- |
| `config.json`, `chats\` | Projects, settings and chat history, as plain JSON |
| `window-view\` | The Hearth tab's browser profile (theme, panel sizes) |
| `cloud-view\` | The Cloud AI tab's browser profile, including your sign-ins to the AI sites |
| `cloud-profile\` | The same, for the fallback Edge windows |

Deleting the whole folder resets Hearth. Deleting just `cloud-view` signs you out of the AI sites in the Cloud AI tab. Downloaded models belong to Ollama, not Hearth, and stay where Ollama keeps them.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| "An Application Control policy has blocked this file", or a SmartScreen warning | The exe is not code-signed. Windows Smart App Control can refuse a freshly built or copied exe; waiting 20 seconds and trying again is often enough. If it stays blocked, that is Windows' decision for this PC: the choices are signing the exe or changing that Windows setting. |
| "Ollama is not running" | Press **Start Ollama** on the banner, or start Ollama from the Start menu. If it is not installed, get it from [ollama.com/download](https://ollama.com/download). |
| "No local models installed yet" | Download one under **Models → Discover**. |
| A model is listed as **Blocked — not local** | It is a cloud-hosted model. The Hearth tab only runs models on this PC; use the Cloud AI tab for cloud services. |
| A model you expect is missing from Discover or Hugging Face | Check the **Model sources** level at the top of that screen; community uploads are hidden unless you choose **Everything**. |
| "Hearth has stopped" covers the window | Close the window and open Hearth again. |
| Hearth opens without the Cloud AI tab | You started `Hearth.exe` directly. Close it and double-click **Open Hearth** (or use the Start menu entry) instead. |
| "Hearth is already open in another window that this one cannot join" | Close the other Hearth window, wait a few seconds, and open Hearth again. |
| The window says the `tools\webview2` folder is missing | Restore that folder from the repository, or run `Hearth.exe` directly without the Cloud AI tab. |
| A link in a Cloud AI pane does nothing, or part of a page fails to load | It leads to an address outside the allowed sites, which the tab blocks by design. Press **Home** in that pane to go back to the site's start page. |
| A site in the Cloud AI tab will not let you sign in | Use the fallback Edge windows: `tools\cloud-windows.ps1`. |
| The GitHub button says **Needs setup** | Install Git for Windows and the GitHub CLI (links are on that screen), then press **Check again**. |
| A file shows a lock and will not open | It is a credential-style file, a protected folder, or something you marked **Protect**. Right-click it to see why. |

### Command-line options

These are optional; normal use needs none of them.

| Command | Effect |
| --- | --- |
| `tools\hearth-window.ps1 -InstallShortcut` | Make the Start menu "Hearth" shortcut open the tabbed window. |
| `tools\hearth-window.ps1 -FolderShortcut` | Create an **Open Hearth** shortcut (with Hearth's icon) next to `Hearth.exe`. It does the same job as `Open Hearth.cmd`. |
| `tools\cloud-windows.ps1` | Show a small picker, then open up to three restricted Edge windows side by side. |
| `tools\cloud-windows.ps1 -Sites claude,chatgpt` | Open those sites directly (one to three of `claude`, `chatgpt`, `gemini`). Opening a new set closes the previous one. |
| `tools\cloud-windows.ps1 -Close` | Close those windows. |
| `Hearth.exe --port 47700` | Use a different local port. By default Hearth uses 47610, or the next free one. |
| `Hearth.exe --no-window` | Start the local service without opening a window. The tabbed window uses this. |
| `Hearth.exe --stay` | Keep the local service running after the last window closes (for development and testing). |

## Safety design

These rules are enforced in code, not just hidden in the interface.

| Area | Rule | Where |
| --- | --- | --- |
| Local only | Inference goes only to Ollama on a loopback address; a remote `OLLAMA_HOST` is ignored and no proxy is used. Cloud-hosted models are refused for chat and for download. | `src/Ollama.cs` |
| File guardrails | Nothing outside the project folder can be touched. Whole drives, the user-profile root and system locations cannot be linked. Credential files (`.env`, keys…), `.git`, `.ssh` and anything you mark **Protect** are locked. Deletes go to the Recycle Bin; nothing is ever overwritten by a create or move. | `src/Guard.cs`, `src/Files.cs` |
| Model sources | A security level (Official only / Trusted publishers / Everything) decides which models appear and is checked again at download time. Other registries, gated or private repositories, and repositories flagged by Hugging Face's security scan are always refused. | `src/Sources.cs` |
| GitHub upload | Sign-in, repository creation and pushing are carried out by the official GitHub CLI and Git; Hearth only starts them and never holds a password or token. Uploads happen only on request, are private by default, leave out every protected file, and stop if one is already tracked. | `src/GitHub.cs` |
| Cloud AI tab | Hearth itself never contacts a cloud AI service. The tab only shows the AI companies' own sites, in a browser profile separate from the Hearth tab. That browser is started so that every address except those sites and their sign-in services fails to resolve, and navigation to any other site is cancelled as a second check. | `tools/hearth-window.ps1`, `tools/cloud-windows.ps1` |
| Interface | The Hearth tab can only talk to its own local service (strict Content-Security-Policy, per-launch session cookie, loopback binding). Links to outside pages open in your normal browser instead. | `src/Server.cs`, `tools/hearth-window.ps1` |

Hearth itself uses the internet only to search the model catalogs (your search words go to ollama.com or huggingface.co), when Ollama downloads a model you chose, and when you upload a project to your own GitHub account. Local chats are never sent anywhere. The Cloud AI tab is the exception by design: its panes are live websites.

## Developing

```
Hearth.exe                the built program (local service and the local-only window)
Open Hearth.cmd           double-click launcher: opens the window with both tabs
src/                      C# backend: local HTTP server, Ollama relay, guardrails, catalogs, storage
app/                      interface of the Hearth tab (index.html, css/, js/)
tools/hearth-window.ps1   the tabbed window: hosts the Hearth tab and the Cloud AI tab
tools/cloud-windows.ps1   fallback: the cloud sites as restricted, tiled Edge windows
tools/webview2/           Microsoft WebView2 SDK files used by hearth-window.ps1
tools/make-icon.ps1       draws the app icon
```

The repository includes a built `Hearth.exe` so a download can be run straight away. To build your own, run `powershell -ExecutionPolicy Bypass -File build.ps1`: it compiles `src\*.cs` with the C# compiler that ships with Windows, builds the interface (`app\`) into the exe, and replaces `Hearth.exe`. On a PC with Smart App Control switched on, Windows may refuse to run a freshly built exe; keep a copy of the working one before rebuilding. The interface is plain HTML, CSS and JavaScript with no build step. While developing, an `app` folder next to the exe takes priority over the built-in copy, so interface edits show up after reopening the window, without a rebuild; backend changes need `build.ps1` again.

The list of sites the Cloud AI tab may reach is at the top of `tools\hearth-window.ps1` (and repeated in `tools\cloud-windows.ps1`); adding a site means adding it, and the hosts it needs, in both.
