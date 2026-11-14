# Hearth

A desktop app for Windows that puts a polished interface on [Ollama](https://ollama.com), so local models can be used without a terminal. Everything that uses AI runs on your own hardware.

## What it does

- **Chat** with any installed model, with streaming replies, "thinking" display, Markdown and code highlighting.
- **Projects** — each has its own chats, instructions and an optional linked folder.
- **Files** — browse the project folder, open files in tabs, edit and save, and attach files to a chat as context. Create, rename, move and delete from the tree.
- **Models** — switch models from a picker, see what is installed and loaded, search the Ollama library and Hugging Face, and download with progress and a "will it fit this PC" hint.
- **GitHub** — sign in from inside the app and upload a project to a new repository in your own account (private by default), or push later changes, with one button.
- **File tools for the model** — the model can list and read project files on its own, and can *ask* to create, edit, move or delete them. Every change is shown first (edits as a before/after comparison) and happens only when you press **Allow**.

## Requirements

- Windows 10 or 11 (uses the built-in .NET Framework 4.8 and Microsoft Edge)
- [Ollama](https://ollama.com/download) installed
- [Git for Windows](https://git-scm.com/download/win) and the [GitHub CLI](https://cli.github.com/), only if you want to upload projects to GitHub

No SDKs, package managers or other downloads are needed.

## Running Hearth

### 1. Get `Hearth.exe`

The built program is not stored in this repository, so build it once. It takes a few seconds and uses only what Windows already has.

1. Download or clone this repository.
2. Open PowerShell in the repository folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File build.ps1
   ```

This writes `Hearth.exe` into the folder. It is a single file with the interface built in, so you can move or copy it anywhere.

### 2. Start it

Double-click `Hearth.exe`. A Hearth window opens. To keep it handy, right-click the file and choose **Pin to Start** or **Send to → Desktop (create shortcut)**.

- Starting Hearth again while it is open just opens another window.
- Closing the last window shuts Hearth down a few seconds later. Nothing keeps running in the background.

### 3. First use

1. **Ollama.** If a banner says Ollama is not running, press **Start Ollama** on it.
2. **Get a model.** Open **Models** (bottom left) → **Discover**, search, expand a model and press **Download** on a version. The badge next to each version says whether it fits this PC's GPU.
3. **Chat.** Pick the model from the picker at the top right and type in the box at the bottom. Enter sends, Shift+Enter makes a new line.
4. **Work with files (optional).** Use the project switcher at the top left → **New project…** and choose a folder. Its files appear under the **Files** tab; open one and press **Add to chat** to give it to the model. With **File tools** switched on in the message box, the model can also read files and ask to change them; each change waits for your **Allow**.
5. **GitHub (optional).** Press **GitHub** at the bottom left to sign in and upload the current project.

### Where your data lives

Projects, settings and chat history are plain JSON files under `%LOCALAPPDATA%\Hearth`. Deleting that folder resets Hearth. Downloaded models belong to Ollama, not Hearth, and stay where Ollama keeps them.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| "An Application Control policy has blocked this file", or a SmartScreen warning | The exe is not code-signed. Windows Smart App Control can refuse a freshly built or copied exe; waiting 20 seconds and trying again is often enough. If it stays blocked, that is Windows' decision for this PC: the choices are signing the exe or changing that Windows setting. |
| "Ollama is not running" | Press **Start Ollama** on the banner, or start Ollama from the Start menu. If it is not installed, get it from [ollama.com/download](https://ollama.com/download). |
| "No local models installed yet" | Download one under **Models → Discover**. |
| A model is listed as **Blocked — not local** | It is a cloud-hosted model. Hearth only runs models on this PC. |
| A model you expect is missing from Discover or Hugging Face | Check the **Model sources** level at the top of that screen; community uploads are hidden unless you choose **Everything**. |
| "Hearth has stopped" covers the window | Close the window and start `Hearth.exe` again. |
| The GitHub button says **Needs setup** | Install Git for Windows and the GitHub CLI (links are on that screen), then press **Check again**. |
| A file shows a lock and will not open | It is a credential-style file, a protected folder, or something you marked **Protect**. Right-click it to see why. |

### Command-line options

These are optional; double-clicking needs none of them.

| Option | Effect |
| --- | --- |
| `--port 47700` | Use a different local port. By default Hearth uses 47610, or the next free one. |
| `--no-window` | Start the local service without opening a window (for development and testing). |
| `--stay` | Keep the local service running after the last window closes (for development and testing). |

## Safety design

All of these are enforced in the backend (`src/`), not just hidden in the interface.

| Area | Rule | Where |
| --- | --- | --- |
| Local only | Inference goes only to Ollama on a loopback address; a remote `OLLAMA_HOST` is ignored and no proxy is used. Cloud-hosted models are refused for chat and for download. | `src/Ollama.cs` |
| File guardrails | Nothing outside the project folder can be touched. Whole drives, the user-profile root and system locations cannot be linked. Credential files (`.env`, keys…), `.git`, `.ssh` and anything you mark **Protect** are locked. Deletes go to the Recycle Bin; nothing is ever overwritten by a create or move. | `src/Guard.cs`, `src/Files.cs` |
| Model sources | A security level (Official only / Trusted publishers / Everything) decides which models appear and is checked again at download time. Other registries, gated or private repositories, and repositories flagged by Hugging Face's security scan are always refused. | `src/Sources.cs` |
| GitHub upload | Sign-in, repository creation and pushing are carried out by the official GitHub CLI and Git; Hearth only starts them and never holds a password or token. Uploads happen only on request, are private by default, leave out every protected file, and stop if one is already tracked. | `src/GitHub.cs` |
| Interface | The window can only talk to its own local service (strict Content-Security-Policy, per-launch session cookie, loopback binding). | `src/Server.cs` |

The internet is used only to search the model catalogs (your search words go to ollama.com or huggingface.co), when Ollama downloads a model you chose, and when you upload a project to your own GitHub account. Chats are never sent anywhere.

## Developing

```
src/     C# backend: local HTTP server, Ollama relay, guardrails, catalogs, storage
app/     interface (index.html, css/, js/)
tools/   make-icon.ps1 — draws the app icon
```

`build.ps1` compiles `src\*.cs` with the C# compiler that ships with Windows and builds the interface (`app\`) into the exe. The interface is plain HTML, CSS and JavaScript with no build step. While developing, an `app` folder next to the exe takes priority over the built-in copy, so interface edits show up after reopening the window, without a rebuild; backend changes need `build.ps1` again.
