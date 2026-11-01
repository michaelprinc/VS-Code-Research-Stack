# VS Code Jupyter extension

Open notebooks and select a research kernel.

## Setup

Install/enable ms-toolsai.jupyter in the relevant editor host. Create the independent analysis environment from notebooks/analysis/uv.lock, then use the notebook kernel picker.

## First task and readiness

Run one intentional cell that prints sys.executable. Confirm it points to notebooks/analysis/.venv before running analysis. The toolkit does not run cells automatically.

## Troubleshooting and limits

Extension presence and environment files do not prove a working kernel. A notebook may still use the wrong interpreter. Verify connection and a small cell manually; diagnostics leaves readiness Not verified.

## Current documentation

[Current official documentation](https://code.visualstudio.com/docs/datascience/jupyter-notebooks). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
