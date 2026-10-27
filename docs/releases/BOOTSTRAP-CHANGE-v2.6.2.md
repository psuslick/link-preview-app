Link Preview App v2.6.2 — Bing SafeSearch bootstrap change
===========================================================

Add this line to run-bootstrap.cmd BEFORE the app/Edge is launched:

reg add "HKCU\Software\Policies\Microsoft\Edge" /v ForceBingSafeSearch /t REG_DWORD /d 0 /f >nul 2>&1

Purpose:
- Sets Microsoft Edge policy to BingSafeSearchNoRestrictionsMode.
- It does NOT turn Bing SafeSearch Off by itself.
- It prevents Edge policy from forcing Moderate/Strict so the Sandbox-only Bing profile can save Bing's own Off setting.

After the Sandbox app opens:
1. Open Privacy & network activity.
2. Under Version Finder — destinations, enable Bing search.
3. Click "Configure Bing Off".
4. In the Sandbox-only Edge window, choose SafeSearch Off and complete any required Bing prompts.
5. Leave that window open until the app reports "Bing SafeSearch — Off verified".
6. You may then leave the window open or close it. Finder searches use that same Sandbox Edge profile/session.

Bing is skipped rather than searched with Moderate/Strict whenever Off has not been verified.
