"""Build the offline hub from independently maintained component guides."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "extension"


def build() -> None:
    catalog = json.loads((ROOT / "components.json").read_text(encoding="utf-8"))
    components = catalog["components"]
    steps = {step["id"]: step["label"] for step in catalog.get("installSteps", [])}
    rows = []
    seen = set()
    for component in components:
        identifier = component["id"]
        if identifier in seen:
            raise ValueError(f"Duplicate component: {identifier}")
        seen.add(identifier)
        guide = ROOT / component["guide"]
        if guide.resolve().parent != (ROOT / "guides").resolve() or guide.suffix != ".md":
            raise ValueError(f"Guide outside the supported directory: {guide}")
        content = guide.read_text(encoding="utf-8")
        for heading in ("## Setup", "## First task and readiness", "## Troubleshooting and limits", "## Current documentation"):
            if heading not in content:
                raise ValueError(f"Missing {heading} in {guide.name}")
        source = component["officialUrl"]
        if source and (not source.startswith("https://") or source not in content):
            raise ValueError(f"Missing/unsafe official source in {guide.name}")
        link = f"[Latest docs]({source})" if source else "Provider not selected"
        install = component.get("install") or {"mode": "external", "step": None}
        mode = install["mode"]
        packages = ", ".join(profile.capitalize() for profile in component.get("profiles", [])) or "none"
        if mode == "managed":
            who = f"Toolkit step: {steps.get(install.get('step'), install.get('step'))} ({packages})"
        elif mode == "planned":
            who = "Not implemented in the toolkit"
        elif mode == "host":
            who = f"You install this host tool ({packages})"
        elif mode == "editor":
            who = f"You install this editor extension ({packages})"
        else:
            who = "External service or manual workflow"
        rows.append(f"| [{component['title']}]({guide.name}) | {component['group']} | {who} | {component['summary']} | {link} |")
    prefix = """# Research Toolkit guide hub

Start with the [onboarding walkthrough](onboarding.md). Open the control panel and run **Check components** to compare observed installation with your selected package preference.

Installation and readiness are separate. Ready names a successful check, such as the running editor, a library test or a real local MCP document fixture workflow. Not verified means a separate MCP session, kernel, account or service task is still needed. Not detected describes inspected locations only. Planned describes an unimplemented toolkit integration, even if an unrelated application exists elsewhere.

Toolkit and Python worker versions are independent. Package selection does not install components. Inventory applies to the selected workspace and current editor host, with a last-check timestamp; it is not a machine-wide inventory.

Each component has an independent guide. Guide opens its bundled snapshot; Latest docs opens maintained official documentation on request. No documents are silently downloaded/replaced at activation. Current upstream instructions can differ from your installed/locked version.

**Who installs it** names the component step the control panel can run for you, or says plainly that a host tool, an editor extension, an external service or a planned integration is outside the toolkit's installer. Selecting a package never runs a step.

| Component guide | Group | Who installs it | Purpose | Current official source |
|---|---|---|---|---|
"""
    (ROOT / "guides" / "index.md").write_text(prefix + "\n".join(rows) + "\n\n[Documentation maintenance](maintenance.md) · [Toolkit controls](toolkit.md)\n", encoding="utf-8")
    print(f"Guide hub built from {len(components)} component guides.")


if __name__ == "__main__":
    build()
