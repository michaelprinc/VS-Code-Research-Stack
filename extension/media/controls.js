"use strict";
(() => {
  const vscode = acquireVsCodeApi();
  const feedback = document.getElementById("feedback");
  let savedPackage;
  let inventory;
  let busy = false;
  let presets = [];
  let budget;
  let activePresetId;
  let messageVersion = "";
  let savedPresetSetting;
  let appliedPresetId;
  let toolSurface;
  let installPlan;
  let installation;
  let recentPresets = [];
  let presetScope = "profile";

  const tokens = (value) => `≈${Math.round(value / 100) / 10}k tokens`;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  function presetById(id) { return presets.find((item) => item.id === id); }

  function presetMeta(preset) {
    const estimate = preset.estimate;
    return `${plural(estimate.toolkitTools, "toolkit tool")}`
      + (estimate.thirdPartyTools ? ` + ${plural(estimate.thirdPartyTools, "external tool")}` : "")
      + ` · ${tokens(estimate.tokensEstimate)} per request`;
  }

  function renderPresets() {
    const list = document.getElementById("preset-list");
    list.replaceChildren();
    for (const preset of presets) {
      const card = document.createElement("label");
      card.className = "preset" + (preset.id === activePresetId ? " selected" : "");
      card.title = preset.goal;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "preset";
      input.value = preset.id;
      input.checked = preset.id === activePresetId;
      const body = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = preset.label;
      if (preset.isPackageDefault) {
        const badge = document.createElement("em");
        badge.textContent = "Default for this package";
        title.append(badge);
      }
      const description = document.createElement("span");
      description.className = "description";
      description.textContent = preset.goal;
      const meta = document.createElement("small");
      meta.textContent = presetMeta(preset);
      meta.title = `Tool definitions are sent with every request. ${preset.estimate.measured
        ? "Toolkit part measured from the installed worker's real tool schemas."
        : "Toolkit part estimated until Set up package components has run."}`
        + ` Ceiling: ${budget.clientCeiling} tools.`;
      body.append(title, description, meta);
      card.append(input, body);
      list.append(card);
    }
    renderPresetDetails();
  }

  function renderPresetDetails() {
    const box = document.getElementById("preset-estimate");
    const note = document.getElementById("preset-note");
    box.replaceChildren();
    const preset = presetById(activePresetId);
    if (!preset) { note.textContent = ""; return; }
    const estimate = preset.estimate;
    const grid = document.createElement("dl");
    grid.className = "estimate";
    const row = (term, value, tip) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (tip) dd.title = tip;
      grid.append(dt, dd);
    };
    row("Goal", preset.goal, "The preset enables the tools that serve this goal, whatever MCP server they come from.");
    row("Toolkit tools", plural(estimate.toolkitTools, "tool"), "Research Stack tools enabled by this goal.");
    row("External tools you configure", estimate.thirdPartyTools ? plural(estimate.thirdPartyTools, "tool") : "None",
      "Estimated from the published toolsets of servers such as GitHub or Playwright. The toolkit does not start or measure those servers.");
    row("Total tools offered", `${estimate.totalTools} of ${budget.clientCeiling}`,
      "Copilot agent mode can enable at most 128 tools at once; a wider surface is refused rather than trimmed.");
    row("Headroom under the ceiling", plural(estimate.headroom, "tool"), "Deliberate headroom so new toolkit tools cannot push the surface over the client ceiling.");
    row("Tool definitions per request", `${tokens(estimate.tokensEstimate)} · ${estimate.contextPercent}% of a ${Math.round(budget.contextWindowReference / 1000)}k window`,
      estimate.measured
        ? "Measured from the installed worker's real tools/list schemas (name + title + description + input schema, characters ÷ 4, plus 40 tokens of framing per tool)."
        : `Estimated at ${budget.vendorTokensPerTool} tokens per tool definition. Run Set up package components to measure the real schemas.`);
    row("Basis", estimate.measured ? "Measured toolkit schemas + vendor estimates for external servers" : "Vendor estimates only (no measured receipt yet)",
      "The measured part comes from the setup receipt written by the real MCP reading check.");
    box.append(grid);
    if (toolSurface && toolSurface.servers) {
      row("Installed worker surface", `${toolSurface.toolCount} tools across ${toolSurface.servers.length} servers · ${tokens(toolSurface.tokensEstimate)}`,
        "Everything the installed toolkit can offer. Your preset registers a subset of it, and unused servers are not started.");
    }
    if ((preset.thirdParty || []).length) {
      const external = document.createElement("ul");
      external.className = "estimate-list";
      for (const item of preset.thirdParty || []) {
        const entry = document.createElement("li");
        entry.textContent = `${item.label}: about ${item.toolsEstimate} tools`;
        entry.title = item.note;
        external.append(entry);
      }
      box.append(external);
    }
    const tools = document.createElement("p");
    tools.className = "estimate-tools";
    tools.textContent = `Toolkit tools in this preset: ${preset.tools.join(", ")}.`;
    tools.title = "Only these tools are registered by the local workers when this preset is saved.";
    box.append(tools);
    const tips = document.createElement("ul");
    tips.className = "tips";
    for (const tip of preset.tips) {
      const item = document.createElement("li");
      item.textContent = tip;
      tips.append(item);
    }
    box.append(tips);
    const requires = document.createElement("p");
    requires.className = "requires";
    requires.textContent = `Needs: ${preset.requires.join(" · ")}.`;
    box.append(requires);
    const messages = {
      focused: `Focused preset: ${estimate.totalTools} tools is well inside the range where tool selection stays reliable.`,
      watch: `Watch this preset: ${estimate.totalTools} tools is above the ${budget.accuracyBand}-tool range where assistants start choosing less reliably.`,
      "near-ceiling": `Close to the limit: ${estimate.totalTools} of ${budget.clientCeiling} tools. Prefer a narrower preset for routine tasks.`,
      "over-ceiling": `Over the limit: ${estimate.totalTools} tools exceeds the ${budget.clientCeiling}-tool ceiling and the assistant will refuse the session.`,
    };
    note.textContent = messages[estimate.level];
    note.className = `check-disclosure level-${estimate.level}`;
    const savedDifferent = savedPresetSetting !== "package-default" && savedPresetSetting !== activePresetId;
    const scopeNote = presetScope === "workspace" || presetScope === "workspaceFolder" ? "Saved for this workspace folder: " : "";
    document.getElementById("saved-preset").textContent = scopeNote + (savedPresetSetting === "package-default"
      ? `Following the package default: ${preset.label}`
      : savedDifferent
        ? `Saved preset "${(presetById(savedPresetSetting) || { label: savedPresetSetting }).label}" is not offered by this package · using ${preset.label}`
        : `Saved: ${preset.label}`);
  }

  const stepLabels = { installed: "Installed", outdated: "Outdated for this toolkit", missing: "Not installed" };
  // A failed step can carry a whole uv traceback. The row shows a summary; the full text is one click away.
  const ERROR_PREVIEW_CHARS = 200;

  function truncate(text, limit) {
    const value = String(text);
    return value.length > limit ? `${value.slice(0, limit - 1)}\u2026` : value;
  }

  /** A control the panel cannot offer in this state: disabled, announced as disabled, and explained. */
  function markUnavailable(control, reason) {
    control.dataset.unavailable = "true";
    control.dataset.unavailableReason = reason;
    control.title = reason;
  }

  function markAvailable(control) {
    const reason = control.dataset.unavailableReason;
    if (reason && control.title === reason) control.removeAttribute("title");
    delete control.dataset.unavailable;
    delete control.dataset.unavailableReason;
  }

  /** Read-only controls (the log, the copied diagnostics) stay usable while a setup runs. */
  const isReadOnly = (control) => control.dataset?.readonly === "true";

  /**
   * One owner of `disabled`. A control that is unavailable is disabled, carries aria-disabled so a
   * keyboard user still reaches it and hears why, and carries a title naming the reason.
   */
  function applyControlAvailability() {
    document.querySelectorAll("button, input, select").forEach((control) => {
      if (isReadOnly(control)) {
        control.disabled = false;
        control.removeAttribute("aria-disabled");
        return;
      }
      const unavailable = control.dataset.unavailable === "true";
      const disabled = Boolean(busy) || unavailable;
      control.disabled = disabled;
      if (!disabled) { control.removeAttribute("aria-disabled"); return; }
      control.setAttribute("aria-disabled", "true");
      if (!control.title) {
        control.title = unavailable
          ? "This control is not available for the current state."
          : "A setup or check is running. This control is available when it finishes.";
      }
    });
  }

  /** What each live setup-lock state means to the person reading the card. */
  const LOCK_TEXT = {
    free: "no setup lock",
    held: "held by a running setup",
    stale: "interrupted lock left behind",
    invalid: "the lock path is not a file",
    "n-a": "no local workspace to inspect",
  };

  /** The evidence the card receives: the log and status record it read, and the live setup lock. */
  function evidenceLine() {
    const element = document.getElementById("install-evidence");
    const files = installation.logFiles || [];
    const parts = [];
    parts.push(files.length
      ? `Setup log: ${files[files.length - 1]}${files.length > 1 ? ` (+${files.length - 1} more)` : ""}`
      : "Setup log: none written yet");
    if (installation.statusFile) parts.push(`Status record: ${installation.statusFile}`);
    const lock = installation.lock;
    const check = ((installation.preflight || {}).checks || []).find((item) => item.id === "setup-lock");
    let lockText;
    let lockDetail;
    if (lock && lock.state) {
      lockText = LOCK_TEXT[lock.state] || lock.state;
      lockDetail = `Setup lock now: ${lock.path || "path not reported"} \u2014 ${lockText}`
        + (lock.reason ? ` (${lock.reason})` : "")
        + (Number.isFinite(lock.ageMs) ? `, ${Math.round(lock.ageMs / 1000)} s old` : "")
        + (lock.ownerPid ? `, pid ${lock.ownerPid}` : "")
        + (lock.state === "stale" ? ". Clear interrupted setup lock removes only that file." : "");
    } else if (check) {
      lockText = ({ ok: "no setup lock", warn: "interrupted lock left behind", fail: "held by a running setup" })[check.status] || check.status;
      lockDetail = `Setup lock at the last setup: ${check.detail}${check.action ? ` ${check.action}` : ""}`;
    } else {
      lockText = "not reported";
      lockDetail = "The panel was given no setup-lock state.";
    }
    parts.push(`Setup lock: ${lockText}`);
    element.title = [
      files.length ? `Setup log files: ${files.join(", ")}` : "No setup log file exists in this workspace.",
      installation.statusFile ? `Status record: ${installation.statusFile}` : "No status record has been written in this workspace.",
      lockDetail,
    ].join("\n");
    return parts.join(" \u00b7 ");
  }

  function selectedSteps() {
    return [...document.querySelectorAll('#install-plan input[data-step]')]
      .filter((input) => input.checked)
      .map((input) => input.dataset.step);
  }

  /** The 0.3.6 installation status card: verdict, per-step attempts, host tools, next action. */
  function renderInstallStatus() {
    const outcome = document.getElementById("install-outcome");
    const meta = document.getElementById("install-meta");
    const list = document.getElementById("install-steps");
    const evidence = document.getElementById("install-evidence");
    const problem = document.getElementById("install-problem");
    const tools = document.getElementById("install-tools");
    const retry = document.getElementById("retry-button");
    list.replaceChildren();
    if (!installation) {
      outcome.textContent = "Installation status is not available for this workspace folder.";
      meta.textContent = ""; problem.textContent = ""; tools.textContent = ""; evidence.textContent = "";
      markUnavailable(retry, "No component setup has been recorded for this workspace, so there is nothing to retry.");
      return;
    }
    outcome.textContent = installation.line;
    outcome.dataset.outcome = installation.outcome;
    meta.textContent = installation.outcome === "not-run"
      ? "Run Set up package components to install the steps this package offers."
      : `${installation.package || "package"} · toolkit ${installation.toolkitVersion} · ${installation.workspaceFolder || "workspace"} · last attempt ${installation.attemptedAt} · ${installation.durationText}`;
    for (const step of installation.steps || []) {
      const item = document.createElement("li");
      item.className = `attempt status-${step.status}`;
      const title = document.createElement("strong");
      title.textContent = step.label;
      const badge = document.createElement("em");
      badge.textContent = step.statusText;
      title.append(badge);
      const detail = document.createElement("small");
      detail.textContent = `${step.duration} · ${step.attemptedAt}`;
      item.append(title, detail);
      if (step.error) {
        const full = String(step.error);
        const short = truncate(full, ERROR_PREVIEW_CHARS);
        const box = document.createElement("details");
        box.className = "step-error";
        const summary = document.createElement("summary");
        summary.textContent = short;
        if (short !== full) summary.title = `Show the full output (${full.length} characters)`;
        const body = document.createElement("pre");
        body.textContent = full;
        box.append(summary, body);
        item.append(box);
      }
      list.append(item);
    }
    problem.textContent = installation.problem
      ? `${installation.problem.label}: ${installation.problem.detail}${installation.problem.action ? ` → ${installation.problem.action}` : ""}`
      : "";
    const tools_ = (installation.hostTools || []).map((tool) => tool.path
      ? `${tool.name} ${tool.version || "version not reported"} (${tool.source})`
      : `${tool.name}: not found`);
    tools.textContent = tools_.length ? `Host tools used by setup: ${tools_.join(" · ")}` : "";
    evidence.textContent = evidenceLine();
    const retryable = (installation.steps || []).some((step) => ["failed", "blocked", "cancelled"].includes(step.status));
    if (retryable) markAvailable(retry);
    else markUnavailable(retry, "Nothing failed, was blocked, or was cancelled, so there is nothing to retry.");
  }

  function renderInstallPlan() {
    const list = document.getElementById("install-plan");
    const summary = document.getElementById("setup-summary");
    list.replaceChildren();
    if (!installPlan || !installPlan.steps.length) {
      summary.textContent = "No component steps are offered by this package.";
      return;
    }
    const counts = installPlan.counts;
    summary.textContent = `${installPlan.package.label}: ${installPlan.steps.filter((step) => step.status === "installed").length} of ${installPlan.steps.length} steps installed`
      + (counts.outdated ? ` · ${counts.outdated} outdated for toolkit ${messageVersion}` : "")
      + (counts.missing ? ` · ${counts.missing} not installed` : "")
      + (counts["needs-repair"] ? ` · ${counts["needs-repair"]} recorded but needing repair` : "")
      + ((installPlan.omittedOptional || []).length ? ` · ${installPlan.omittedOptional.length} optional step(s) not installed` : "")
      + ` · ${installPlan.package.gate}.`;
    for (const step of installPlan.steps) {
      const card = document.createElement("label");
      card.className = `step status-${step.status}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.step = step.id;
      input.checked = step.selected;
      input.disabled = step.status === "installed";
      if (step.status === "needs-repair") input.checked = true;
      const body = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = step.label;
      const badge = document.createElement("em");
      badge.textContent = stepLabels[step.status] + (step.optional ? " · optional" : "") + (step.downloads ? " · may download" : "");
      title.append(badge);
      const description = document.createElement("span");
      description.className = "description";
      description.textContent = step.description;
      const meta = document.createElement("small");
      meta.textContent = `${step.components.length} component(s): ${step.components.join(", ")}`;
      meta.title = step.evidence + (step.installedAt ? ` · recorded ${new Date(step.installedAt).toLocaleString()}` : "")
        + ` · needs ${step.prerequisites.length ? step.prerequisites.join(", ") : "nothing installed first"}`
        + (step.omitted ? " · deliberately omitted optional step" : "");
      body.append(title, description, meta);
      card.append(input, body);
      list.append(card);
    }
    const update = document.getElementById("update-button");
    const outdated = installPlan.steps.filter((step) => step.status === "outdated");
    const repair = installPlan.steps.filter((step) => step.status === "needs-repair");
    const actionable = [...outdated, ...repair];
    update.textContent = actionable.length ? `Update or repair ${actionable.length} component step(s)` : "No components to update";
    const reason = actionable.length
      ? `${outdated.length ? `Installed by ${outdated.map((step) => step.installedVersion).join(", ")} and refreshable to ${messageVersion}.` : ""}${repair.length ? ` ${repair.map((step) => step.id).join(", ")} are recorded by this release but the files they produced are missing.` : ""}`.trim()
      : "Every installed step matches this toolkit release and its produced files are present.";
    if (actionable.length) { markAvailable(update); update.title = reason; }
    else markUnavailable(update, reason);
  }

  function renderRecentPresets() {
    const box = document.getElementById("recent-presets");
    box.replaceChildren();
    const usable = recentPresets.filter((id) => presets.some((preset) => preset.id === id));
    if (!usable.length) return;
    const label = document.createElement("span");
    label.textContent = "Recently used:";
    box.append(label);
    for (const id of usable) {
      const preset = presets.find((item) => item.id === id);
      const button = document.createElement("button");
      button.className = "secondary chip";
      button.textContent = preset.label;
      button.title = `Save "${preset.label}" again (${preset.estimate.toolkitTools} toolkit tools).`;
      button.addEventListener("click", () => send({ type: "setPreset", id }));
      box.append(button);
    }
  }

  function renderComponents() {
    const list = document.getElementById("component-list");
    const query = document.getElementById("component-search").value.toLowerCase();
    list.replaceChildren();
    if (!inventory) return;
    const items = inventory.components.filter((item) => `${item.title} ${item.group} ${item.installed} ${item.readiness}`.toLowerCase().includes(query));
    if (!items.length) { list.textContent = "No matching components."; return; }
    for (const item of items) {
      const row = document.createElement("article");
      row.className = "component-row";
      const title = document.createElement("h3"); title.textContent = item.title; row.append(title);
      const status = document.createElement("p"); status.className = "component-status";
      status.textContent = `${item.installed} · Version: ${item.version || "Unknown / not applicable"} · Readiness: ${item.readiness}`; row.append(status);
      const detail = document.createElement("p"); detail.textContent = item.evidence; row.append(detail);
      if (item.location) { const location = document.createElement("p"); location.className = "location"; location.textContent = item.location; row.append(location); }
      const actions = document.createElement("div"); actions.className = "actions";
      if (item.installable) {
        const step = installPlan && installPlan.steps.find((entry) => entry.id === item.installStep);
        if (step && step.status !== "installed") {
          const button = document.createElement("button");
          button.textContent = step.status === "outdated" ? "Update" : "Install";
          button.title = `${item.nextAction} Provided by the "${step.label}" component step.`;
          button.addEventListener("click", () => send({ type: "installComponent", id: item.id }));
          actions.append(button);
        }
      }
      for (const [type, label] of [["guide", "Guide"], ["docs", "Latest docs"]]) {
        const button = document.createElement("button"); button.className = "secondary"; button.textContent = label;
        if (type === "docs" && !item.officialUrl) markUnavailable(button, "No provider has been selected for this component, so there are no official docs to open.");
        button.addEventListener("click", () => send({ type, id: item.id })); actions.append(button);
      }
      const reviewed = document.createElement("small"); reviewed.textContent = `Local guide reviewed: ${item.reviewedAt}`; actions.append(reviewed);
      row.append(actions); list.append(row);
    }
  }
  // One id per outgoing request, so a result can be matched to the action that caused it
  // and a late result for an abandoned request is not shown as the answer to the current one.
  let nextRequestId = 1;
  const pendingRequests = new Set();
  function send(message) {
    message.requestId = nextRequestId++;
    pendingRequests.add(message.requestId);
    document.querySelectorAll("button, input, select").forEach((control) => {
      if (isReadOnly(control)) return;
      control.disabled = true;
      control.setAttribute("aria-disabled", "true");
    });
    feedback.classList.remove("error");
    feedback.textContent = "Working…";
    vscode.postMessage(message);
  }
  document.getElementById("package-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = document.querySelector('input[name="package"]:checked');
    if (selected) send({ type: "setPackage", id: selected.value });
  });
  document.getElementById("preset-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = document.querySelector('input[name="preset"]:checked');
    if (selected) send({ type: "setPreset", id: selected.value });
  });
  document.getElementById("preset-follow").addEventListener("click", () => send({ type: "setPreset", id: "package-default" }));
  document.getElementById("save-preset-workspace").addEventListener("click", () => {
    const selected = document.querySelector('input[name="preset"]:checked');
    if (selected) send({ type: "setPreset", id: selected.value, scope: "workspaceFolder" });
  });
  document.getElementById("setup-button").addEventListener("click", () => send({ type: "setup", steps: selectedSteps() }));
  document.getElementById("update-button").addEventListener("click", () => send({ type: "update", steps: selectedSteps() }));
  document.getElementById("preset-list").addEventListener("change", (event) => {
    activePresetId = event.target.value;
    renderPresets();
    feedback.classList.remove("error");
    feedback.textContent = activePresetId === savedPresetSetting
      ? appliedPresetId === activePresetId
        ? "This tools preset is saved and applied to the assistant's tool list."
        : "This tools preset is saved but not applied yet: the assistant still has the previous tool list. Reload the window or run a component check to apply it."
      : "Click Save tools preset to offer these tools to your assistant.";
  });
  document.getElementById("show-status-bar").addEventListener("change", (event) => send({ type: "setOption", key: "showStatusBar", value: event.target.checked }));
  document.getElementById("open-on-startup").addEventListener("change", (event) => send({ type: "setOption", key: "openControlPanelOnStartup", value: event.target.checked }));
  document.getElementById("diagnostics-workspace").addEventListener("change", (event) => send({ type: "selectWorkspace", index: Number(event.target.value) }));
  document.getElementById("component-search").addEventListener("input", renderComponents);
  // Buttons with their own handler above must not also fire a generic action message: one click, one message.
  document.getElementById("retry-button").addEventListener("click", () => send({ type: "action", action: "retry" }));
  const dedicatedHandlers = new Set(["setup-button", "update-button", "preset-follow", "save-preset-workspace", "retry-button"]);
  // Every other data-action button in the panel is wired here. An action that is neither in the
  // set above nor handled by this loop would be a button that sends nothing.
  document.querySelectorAll("[data-action]").forEach((button) => {
    if (dedicatedHandlers.has(button.id)) return;
    button.addEventListener("click", () => send({ type: "action", action: button.dataset.action }));
  });
  document.querySelectorAll('input[name="package"]').forEach((input) => input.addEventListener("change", () => {
    feedback.classList.remove("error");
    feedback.textContent = input.value === savedPackage ? "This package preference is already saved." : "Click Save package preference to apply your choice.";
  }));
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "state") {
      busy = message.busy;
      savedPackage = message.selectedPackage;
      document.getElementById("version").textContent = `v${message.version}`;
      document.getElementById("workspace").textContent = message.workspace;
      document.getElementById("trust").textContent = message.trusted ? "Trusted workspace" : "Restricted mode · preference controls available";
      document.getElementById("saved-package").textContent = `Saved: ${message.packages.find((item) => item.id === savedPackage).label}`;
      document.querySelectorAll('input[name="package"]').forEach((input) => { input.checked = input.value === savedPackage; });
      document.getElementById("show-status-bar").checked = message.showStatusBar;
      document.getElementById("open-on-startup").checked = message.openControlPanelOnStartup;
      const folders = document.getElementById("diagnostics-workspace");
      folders.replaceChildren();
      for (const folder of message.folders.length ? message.folders : [{ index: 0, name: "No workspace · host tools only" }]) {
        const option = document.createElement("option"); option.value = folder.index; option.textContent = folder.name; folders.append(option);
      }
      folders.value = String(message.diagnosticsWorkspace);
      if (message.folders.length) markAvailable(folders);
      else markUnavailable(folders, "Only this workspace is open, so there is no other folder to inspect.");
      inventory = message.inventory;
      presets = message.presets || [];
      budget = message.toolBudget;
      toolSurface = message.toolSurface;
      installPlan = message.installPlan;
      installation = message.installation;
      recentPresets = message.recentPresets || [];
      presetScope = message.toolsPresetScope || "profile";
      messageVersion = message.version;
      savedPresetSetting = message.toolsPresetSetting;
      appliedPresetId = message.appliedToolsPreset;
      activePresetId = message.selectedToolsPreset;
      document.getElementById("setup-progress").textContent = message.progressMessage || "";
      const reading = message.readingResult || inventory.readingCheck;
      const readingElement = document.getElementById("reading-result"); readingElement.replaceChildren();
      if (reading) {
        const summary = document.createElement("p");
        summary.textContent = reading.document ? `Reading ${reading.ok ? "passed" : "failed"}: ${reading.document}. ${reading.detail}` : reading.ok ? "MCP check passed: PDF/DOCX reading, source hashes/locators, reports, local search and RIS preparation. External providers were not checked." : `Reading check failed: ${reading.detail}`;
        readingElement.append(summary);
        if (reading.preview) { const preview = document.createElement("pre"); preview.textContent = reading.preview; readingElement.append(preview); }
      }
      document.getElementById("inventory-scope").textContent = `${inventory.scope} · Last check: ${inventory.checkedAt ? new Date(inventory.checkedAt).toLocaleString() : "Not run"}`;
      renderComponents();
      renderPresets();
      renderInstallPlan();
      renderInstallStatus();
      renderRecentPresets();
      applyControlAvailability();
    } else if (message.type === "result") {
      if (message.requestId !== undefined && pendingRequests.size && !pendingRequests.has(message.requestId)) return;
      if (message.requestId !== undefined) pendingRequests.delete(message.requestId);
      applyControlAvailability();
      feedback.classList.toggle("error", Boolean(message.error));
      feedback.textContent = message.error || message.message;
    }
  });
  vscode.postMessage({ type: "ready" });
})();
