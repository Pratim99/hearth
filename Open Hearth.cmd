@echo off
rem Opens Hearth with both tabs: Hearth (local) and Cloud AI.
rem Hearth.exe on its own opens the local-only window, without the Cloud AI tab.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\hearth-window.ps1"
