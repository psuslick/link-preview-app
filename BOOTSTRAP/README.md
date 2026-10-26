# BOOTSTRAP — Git-safe scripts

The three `.cmd` files in this folder contain no passwords, cookies, private
video URLs, HA/Kuma addresses, or tokens. **These scripts may be committed to
Git.** They execute **only in Windows Sandbox**.

## Deploy once on the Windows host (copy files only)

Your `.wsb` maps `C:\SandboxBootstrap` read-only. From this repository, **copy**
this entire `BOOTSTRAP` folder to:

```text
C:\SandboxBootstrap\BOOTSTRAP\run-bootstrap.cmd
C:\SandboxBootstrap\BOOTSTRAP\restart-app.cmd
C:\SandboxBootstrap\BOOTSTRAP\start-diagnostic.cmd
```

Keep your existing read-only host dependency payload alongside that folder:

```text
C:\SandboxBootstrap\git\cmd\git.exe
C:\SandboxBootstrap\node\node.exe
C:\SandboxBootstrap\node\npm.cmd
C:\SandboxBootstrap\SearXNGforWindows-main\...  (optional)
```

Optional pre-extracted `deps/server-node_modules` and `deps/client-node_modules`
can reduce startup npm downloads; these are dependencies, **not source files to
commit to Git**. They may contain native executables. Download/unpack/inspect
them separately and never execute the package on your host.

`run-bootstrap.cmd` clones the published repository into Sandbox-local `C:\App`,
installs dependencies only within Sandbox, launches Node/Vite, then starts a
separate Sandbox Edge profile with the tab collector enabled when supported.
There is no mapped-folder write path or persistent diagnostic log. All tool and
npm-cache writes are Sandbox-local.

## Edge extension note

`--load-extension` is attempted as a startup convenience, **not guaranteed**
with every Edge build/policy. If tabs aren't available, open `edge://extensions`
and load unpacked `C:\App\edge-tab-collector` manually in the same Edge
profile. Do not weaken the `.wsb` security settings to fix that.

## Legacy files

`LEGACY-DO-NOT-RUN/` preserves the original scripts for review only. In
particular, the historic `bootstrap.ps1` downloads installers from the internet
and is **not** the current Sandbox bootstrap.

Never put live cookies, Bing session seeds, credentials, link lists, tokens, or
host-personalized config in this Git-tracked folder. If needed for local use,
place them in `BOOTSTRAP/LOCAL-ONLY-DO-NOT-COMMIT/` (ignored by Git).
