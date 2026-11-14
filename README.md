# Hearth

A desktop app for Windows that puts a polished interface on [Ollama](https://ollama.com), so local models can be used without a terminal. Everything that uses AI runs on your own hardware.

## What it does

- **Chat** with any installed model, with streaming replies, "thinking" display, Markdown and code highlighting.
- **Projects** — each has its own chats, instructions and an optional linked folder.
- **Files** — browse the project folder, open files in tabs, edit and save, and attach files to a chat as context. Create, rename, move and delete from the tree.
- **Models** — switch models from a picker, see what is installed and loaded, search the Ollama library and Hugging Face, and download with progress and a "will it fit this PC" hint.
- **GitHub** — sign in from inside the app and upload a project to a new repository in your own account (private by default), or push later changes, with one button.
- **File tools for the model** — the model can list and read project files on its own, and can *ask* to create, edit, move or delete them. Every change is shown first (edits as a before/after comparison) and happens only when you press **Allow**.

## Safety design

All of these are enforced in the backend (`src/`), not just hidden in the interface.

| Area | Rule | Where |
| --- | --- | --- |
| Local only | Inference goes only to Ollama on a loopback address; a remote `OLLAMA_HOST` is ignored and no proxy is used. Cloud-hosted models are refused for chat and for download. | `src/Ollama.cs` |
| File guardrails | Nothing outside the project folder can be touched. Whole drives, the user-profile root and system locations cannot be linked. Credential files (`.env`, keys…), `.git`, `.ssh` and anything you mark **Protect** are locked. Deletes go to the Recycle Bin; nothing is ever overwritten by a create or move. | `src/Guard.cs`, `src/Files.cs` |
| Model sources | A security level (Official only / Trusted publishers / Everything) decides which models appear and is checked again at download time. Other registries, gated or private repositories, and repositories flagged by Hugging Face's security scan are always refused. | `src/Sources.cs` |
| GitHub upload | Sign-in is handled by Git Credential Manager in GitHub's own window; the token is used only for api.github.com and never stored or shown by Hearth. Uploads happen only on request, leave out every protected file, and stop if one is already tracked. | `src/GitHub.cs` |
| Interface | The window can only talk to its own local service (strict Content-Security-Policy, per-launch session cookie, loopback binding). | `src/Server.cs` |

The internet is used only to search the model catalogs (your search words go to ollama.com or huggingface.co), when Ollama downloads a model you chose, and when you upload a project to your own GitHub account. Chats are never sent anywhere.

## Requirements

- Windows 10 or 11 (uses the built-in .NET Framework 4.8 and Microsoft Edge)
- [Ollama](https://ollama.com/download) installed
- [Git for Windows](https://git-scm.com/download/win), only if you want to upload projects to GitHub

No SDKs, package managers or other downloads are needed.

## Build and run

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
.\Hearth.exe
```

`build.ps1` compiles `src\*.cs` with the C# compiler that ships with Windows and writes `Hearth.exe` next to the `app` folder, which it needs at run time. The interface is plain HTML, CSS and JavaScript in `app\` and needs no build step.

## Layout

```
src/     C# backend: local HTTP server, Ollama relay, guardrails, catalogs, storage
app/     interface (index.html, css/, js/)
tools/   make-icon.ps1 — draws the app icon
```

Projects, settings and chat history are stored as JSON under `%LOCALAPPDATA%\Hearth`.
