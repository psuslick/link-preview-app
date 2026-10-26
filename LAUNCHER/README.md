# LAUNCHER — Git-safe Windows Sandbox configuration

`linkPreviewApp-hardened.wsb` is the active, Git-safe configuration.
It contains only the generic local path `C:\SandboxBootstrap`, not a user name,
secret, private link, HA/Kuma address or service token. **It is safe to commit**
to the public source repository in its current form.

The launcher requires a Windows host directory `C:\SandboxBootstrap`, maps it
into Sandbox with `<ReadOnly>true</ReadOnly>`, and executes:

```text
C:\Users\WDAGUtilityAccount\Desktop\SandboxBootstrap\BOOTSTRAP\run-bootstrap.cmd
```

The Sandbox configuration keeps networking enabled for public video previews,
vGPU/audio input/video input/printers disabled, Protected Client enabled, and
clipboard redirection enabled for the user's manual paste/copy workflow.

Run the `.wsb` from the host after the BOOTSTRAP folder has been **copied** to the
host dependency directory. No source script is run on the host. The bootstrap
clones the GitHub repository into Sandbox-local `C:\App`.

## DO NOT COMMIT PERSONALIZED LAUNCHERS

`LOCAL-ONLY-DO-NOT-COMMIT/` is intentionally ignored by `.gitignore`. Place
machine-specific launchers, host username paths, customized mappings or secrets
there. The uploaded older `linkPreviewApp.wsb` was put there as a `.disabled`
file because it mounted the host directory with `<ReadOnly>false</ReadOnly>` and
turned ProtectedClient off. **Never run that older launcher.**
