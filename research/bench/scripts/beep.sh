#!/bin/sh
# Ask the person to look at the evaluation terminal. Windows beep from WSL, else the terminal bell.
powershell.exe -NoProfile -Command "[console]::beep(880,400)" >/dev/null 2>&1 || printf '\a' >/dev/tty 2>/dev/null || true
