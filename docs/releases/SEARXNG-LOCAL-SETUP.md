Link Preview App v2.7.1 — Local SearXNG setup
================================================

WHY YOU SAW ECONNREFUSED
------------------------
v2.7.0 added the SearXNG client integration but did not include/start a SearXNG
service. v2.7.1 can auto-start a local Windows-compatible SearXNG runtime when
one is present in the existing read-only SandboxBootstrap mapping.

NO HOST EXECUTION IS REQUIRED
-----------------------------
Do NOT run the included .bat/.vbs/python.exe files on your normal Windows host.
You only download and extract the dependency payload. Link Preview invokes its
embedded Python only after Windows Sandbox starts.

DIRECT ZIP DOWNLOAD
-------------------
Download the current Windows-oriented SearXNG package directly from GitHub:

https://github.com/mbaozi/SearXNGforWindows/archive/refs/heads/main.zip

This is an UNOFFICIAL Windows adaptation of SearXNG, not an upstream-supported
Windows build. Its README currently says it packages embedded Python 3.11.9 and
SearXNG synced to upstream 2026-08-19. It is being used only inside disposable
Windows Sandbox because upstream SearXNG does not officially support native
Windows.

PLACEMENT
---------
Extract the ZIP under:

C:\SandboxBootstrap\

Any of these layouts are auto-detected inside Sandbox:

C:\SandboxBootstrap\searxng-windows\python\python.exe
C:\SandboxBootstrap\SearXNGforWindows\python\python.exe
C:\SandboxBootstrap\SearXNGforWindows-main\python\python.exe

The ZIP naturally extracts as SearXNGforWindows-main, so the simplest choice is
just to leave that folder name unchanged.

WHAT v2.7.1 DOES INSIDE SANDBOX
-------------------------------
1. Detects the package through the existing read-only SandboxBootstrap mapping.
2. Generates a fresh settings.yml under Sandbox-local %TEMP%.
3. Starts the embedded Python/SearXNG process inside Sandbox only.
4. Binds SearXNG to 127.0.0.1:8888 only.
5. Enables JSON results and sets SearXNG SafeSearch default to 0.
6. Enables a broad set of general/video engines.
7. Deliberately disables SearXNG's Bing/Bing Videos engines because Link Preview
   keeps Bing on its separate verified SafeSearch-Off Edge-session path.
8. Finder queries SearXNG with safesearch=0 and categories=general,videos.
9. If local SearXNG cannot start, Link Preview falls back to its direct engines.

The runtime package remains read-only. Python bytecode/cache and SearXNG config
are redirected into Sandbox-local temporary storage and disappear at shutdown.

TEST
----
Launch the same hardened .wsb. After the app opens, Privacy & network activity
should show SearXNG as healthy. Press Test if desired. Expected endpoint:

http://127.0.0.1:8888

No .wsb or run-bootstrap.cmd change is required for v2.7.1.
