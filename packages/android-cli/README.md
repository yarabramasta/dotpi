# pi-android-cli

Android tooling extension for Pi: SDK/emulator/device management, docs search,
project scaffolding, deploy, and UI inspection. Tools call the local Android
SDK/CLI directly — no MCP server.

## Commands

```text
/android-init           # initialize Android CLI environment and install skills
/android-update         # update Android CLI to latest version
/android-studio-detect  # re-detect Android Studio and enable studio tools
```

## Tools

```text
android_info                # SDK path, CLI version, launcher version
android_emulator            # create/start/stop/list/remove AVDs
android_sdk                 # install/update/remove/list SDK packages
android_docs                # search/fetch the official Android knowledge base
android_project_create      # scaffold a new project from a template
android_project_describe    # analyze a project's build targets and artifacts
android_run                 # deploy built APKs to a device or emulator
android_layout              # inspect the running app's UI hierarchy as JSON
android_screen              # capture screenshots; annotate + resolve element coordinates
android_studio              # Android Studio integration (enabled via /android-studio-detect)
```
