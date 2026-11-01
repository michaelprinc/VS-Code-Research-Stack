# uv environment manager

Create reproducible locked Python environments.

## Setup

Install uv using its current official instructions. From the source checkout, run `uv sync --locked --python 3.12`. For an initialized research folder, use `uv sync --locked --python 3.12 --project "<workspace>/.research-toolkit/worker"`. Setup may download dependencies; diagnostics never runs sync. The toolkit does not install uv for you: if it is not on the editor process PATH, set `researchStack.uvPath` to its absolute executable path.

## First task and readiness

Run Check components. The toolkit resolves uv in a fixed order — `researchStack.uvPath`, then absolute `PATH` entries, then the documented install locations for the platform (Windows: `%USERPROFILE%\.local\bin`, `%LOCALAPPDATA%\Programs\uv`, `%APPDATA%\Python\Python312\Scripts`, `%APPDATA%\Python\Scripts`, scoop shims, WinGet Links, `C:\Program Files\uv`; macOS/Linux: `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `~/.local/bin`, `~/.cargo/bin`, `$XDG_BIN_HOME`), then the workspace's managed toolkit folder — and reports which one answered. A resolved tool is version-probed with `uv --version`; the row shows the version and the resolution source. Initialize and sync the document worker separately; a working uv does not prove dependencies are installed.

## Troubleshooting and limits

Not detected means no executable was found in the categories searched, and the row names how many PATH entries and documented locations were checked. Restart VS Code after PATH changes so the editor process inherits them, or set `researchStack.uvPath`. A uv that exists but does not answer `--version`, or that is older than the required 0.5.0, is reported as a failed check rather than as installed, and setup refuses to run with it. An executable inside the workspace is refused as a host tool. Setup is blocked before anything is written when uv cannot be resolved. The project lock defines dependencies; current docs may describe features newer than your installed uv.

## Current documentation

[Current official documentation](https://docs.astral.sh/uv/guides/projects/). Local onboarding reviewed on 1 November 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
