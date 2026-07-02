const pluginBase = location.pathname.startsWith("/plugins/crabhelm") ? "/plugins/crabhelm" : "";
const apiBase = `${pluginBase}/api`;

const state = {
  data: null,
  view: location.hash.replace(/^#/, "") || "fleet",
  search: "",
  filter: "all",
  selectedId: null,
  token: "",
  batchResult: null,
  githubPreview: null,
  policyPreview: null,
};

const root = document.querySelector("#view-root");
const drawer = document.querySelector("#drawer");
const drawerContent = document.querySelector("#drawer-content");
const newDialog = document.querySelector("#new-dialog");
const bulkDialog = document.querySelector("#bulk-dialog");
const githubDialog = document.querySelector("#github-dialog");
const templateDialog = document.querySelector("#template-dialog");
const policyDialog = document.querySelector("#policy-dialog");
const authDialog = document.querySelector("#auth-dialog");

const viewMeta = {
  fleet: ["Fleet composition / Parent 01", "Fleet"],
  templates: ["Desired state / Versioned controls", "Policies"],
  deployments: ["Substrate / Child-core placement", "Deployments"],
  activity: ["Metadata only / No conversation content", "Activity"],
};

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
document.querySelector("#refresh-button").addEventListener("click", () => loadState(true));
document.querySelector("#new-button").addEventListener("click", () => openCreateDialog(newDialog));
document.querySelector("#bulk-button").addEventListener("click", () => openCreateDialog(bulkDialog));
document.querySelector("#github-button").addEventListener("click", openGithubDialog);
document.querySelector("#template-button").addEventListener("click", openTemplateDialog);
document.querySelector("#operator-button").addEventListener("click", () => authDialog.showModal());
document.querySelector("#new-form").addEventListener("submit", createClaw);
document.querySelector("#bulk-form").addEventListener("submit", createMaintainers);
document.querySelector("#github-form").addEventListener("submit", importGithubMembers);
document.querySelector("#github-preview-button").addEventListener("click", previewGithubMembers);
document.querySelector('#github-form select[name="scope"]').addEventListener("change", syncGithubScope);
document.querySelectorAll('#github-form [name="organization"], #github-form [name="target"], #github-form [name="role"]').forEach((control) => {
  control.addEventListener(control.tagName === "SELECT" ? "change" : "input", invalidateGithubPreview);
});
document.querySelector("#github-preview").addEventListener("change", syncGithubSelection);
document.querySelector("#template-form").addEventListener("submit", applyTemplate);
document.querySelector("#policy-form").addEventListener("submit", savePolicy);
document.querySelector("#policy-preview-button").addEventListener("click", previewPolicy);
document.querySelector("#policy-apply-id").addEventListener("change", syncPolicyVersions);
document.querySelector("#policy-apply-version").addEventListener("change", invalidatePolicyPreview);
document.querySelector("#template-targets").addEventListener("change", () => {
  syncCanaryOptions();
  invalidatePolicyPreview();
});
document.querySelector("#policy-canary").addEventListener("change", invalidatePolicyPreview);
document.querySelector("#auth-form").addEventListener("submit", connectOperator);
document.querySelectorAll("[data-deployment-target]").forEach((select) => {
  select.addEventListener("change", () => syncDeploymentProfile(select.closest("form")));
});
document.addEventListener("click", (event) => {
  const id = event.target.closest("[data-close-dialog]")?.dataset.closeDialog;
  if (id) document.getElementById(id)?.close();
});
drawer.addEventListener("click", handleDrawerClick);
root.addEventListener("click", handleViewClick);
root.addEventListener("input", handleViewInput);

setView(state.view);
renderLoading();
loadState();

async function loadState(showNotice = false) {
  try {
    state.data = await request("/state");
    syncRuntimeActions();
    render();
    if (showNotice) toast("Fleet state refreshed");
  } catch (error) {
    if (error.message !== "authentication required") {
      renderError(error.message);
    }
  }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body) headers.set("content-type", "application/json");
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  if (response.status === 401) {
    document.querySelector("#operator-state").textContent = "Authentication required";
    if (!authDialog.open) authDialog.showModal();
    throw new Error("authentication required");
  }
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function setView(view) {
  if (!viewMeta[view]) return;
  state.view = view;
  location.hash = view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const [eyebrow, title] = viewMeta[view];
  document.querySelector("#view-eyebrow").textContent = eyebrow;
  document.querySelector("#view-title").textContent = title;
  document.querySelector("#template-button").hidden = view !== "fleet";
  render();
}

function render() {
  if (!state.data) return renderLoading();
  if (state.view === "templates") return renderTemplates();
  if (state.view === "deployments") return renderDeployments();
  if (state.view === "activity") return renderActivity();
  renderFleet();
}

function renderFleet() {
  const { summary, claws } = state.data;
  const visible = claws.filter((claw) => {
    if (claw.observed.phase === "deleted") return false;
    const query = state.search.toLowerCase();
    const matchesSearch = !query || [
      claw.desired.name,
      claw.desired.slug,
      claw.desired.owner.label,
      claw.desired.owner.subject,
      claw.desired.inference.model,
    ].some((value) => value.toLowerCase().includes(query));
    const matchesFilter =
      state.filter === "all" ||
      (state.filter === "drift" && claw.desired.generation !== claw.observed.generation) ||
      claw.observed.phase === state.filter;
    return matchesSearch && matchesFilter;
  });

  root.innerHTML = `${renderRuntimeBanner()}${renderBatchResult()}
    <section class="metrics" aria-label="Fleet summary">
      ${metric("Total claws", summary.total)}
      ${metric("Policy converged", summary.ready, "good")}
      ${metric("In flight", summary.provisioning, summary.provisioning ? "warn" : "")}
      ${metric("Attention", summary.attention, summary.attention ? "bad" : "")}
      ${metric("Disabled", summary.disabled)}
      ${metric("Drifted", summary.drifted, summary.drifted ? "warn" : "")}
    </section>
    ${renderCoreMap(claws.filter((claw) => claw.observed.phase !== "deleted"))}
    <section class="section-head">
      <div><h2>Child cores</h2><p>Every row is one Gateway, state root, pairing store, and OS identity.</p></div>
      <div class="tools">
        <label class="search"><input id="fleet-search" value="${escapeAttr(state.search)}" placeholder="Search user, claw, model…" aria-label="Search fleet" /></label>
        <select class="filter-select" id="fleet-filter" aria-label="Filter fleet">
          ${["all", "ready", "provisioning", "enrolling", "attention", "disabled", "drift"].map((value) => `<option value="${value}" ${state.filter === value ? "selected" : ""}>${phaseLabel(value)}</option>`).join("")}
        </select>
      </div>
    </section>
    ${visible.length ? renderClawList(visible) : renderEmpty(claws.length === 0)}
  `;
}

function metric(labelText, value, tone = "") {
  const displayValue = typeof value === "number" ? Number(value || 0) : escapeHtml(value);
  return `<div class="metric ${tone}"><span>${escapeHtml(labelText)}</span><strong>${displayValue}</strong></div>`;
}

function renderCoreMap(claws) {
  const positions = [[18,34],[82,31],[12,72],[88,69],[33,84],[67,86],[28,18],[72,17]];
  const displayed = claws.slice(0, positions.length);
  const lines = displayed.map((_, index) => {
    const [x, y] = positions[index];
    return `<line x1="50" y1="50" x2="${x}" y2="${y}" vector-effect="non-scaling-stroke"></line>`;
  }).join("");
  const nodes = displayed.map((claw, index) => {
    const [x, y] = positions[index];
    const tone = statusTone(claw.observed.phase);
    return `<button class="child-node ${tone}" style="left:${x}%;top:${y}%" data-claw-id="${escapeAttr(claw.id)}" title="${escapeAttr(claw.desired.name)}"><i></i><b>${escapeHtml(claw.desired.name)}</b></button>`;
  }).join("");
  return `<section class="core-map" aria-label="Parent and child core topology">
    <span class="map-label">Control topology · not shared runtime</span>
    <span class="map-legend"><span><i></i>Policy converged</span><span><i class="warn-dot"></i>Needs work</span></span>
    <svg class="map-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
    <div class="parent-node"><strong>Parent core</strong><span>Crabhelm</span></div>
    ${nodes}
  </section>`;
}

function renderClawList(claws) {
  const rows = claws.map((claw) => {
    const phase = claw.observed.phase;
    const tone = statusTone(phase);
    const drift = claw.desired.generation !== claw.observed.generation;
    const initials = claw.desired.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
    return `<article class="claw-row ${tone} ${phase === "attention" ? "attention" : ""}" data-claw-id="${escapeAttr(claw.id)}" tabindex="0">
      <div class="claw-name"><span class="claw-glyph">${escapeHtml(initials)}</span><span><strong>${escapeHtml(claw.desired.name)}</strong><small>${escapeHtml(claw.desired.slug)}</small></span></div>
      <div><span class="cell-main">${escapeHtml(claw.desired.owner.label)}</span><span class="cell-sub">${escapeHtml(claw.desired.owner.source)}</span></div>
      <div><span class="cell-main">${escapeHtml(shortModel(claw.desired.inference.model))}</span><span class="cell-sub">${escapeHtml(claw.desired.inference.provider)}</span></div>
      <div><span class="status ${tone}">${escapeHtml(phaseLabel(phase))}</span><span class="cell-sub">${escapeHtml(relativeTime(claw.updatedAt))}</span></div>
      <div><span class="cell-main">${escapeHtml(claw.desired.deployment.profile)}</span><span class="cell-sub">${escapeHtml(claw.desired.deployment.target)}</span></div>
      <div class="row-arrow"><span class="generation ${drift ? "drift" : ""}">g${claw.observed.generation}/${claw.desired.generation}</span> &nbsp;›</div>
    </article>`;
  }).join("");
  return `<section class="claw-list">
    <div class="list-head"><span>Claw</span><span>Intended user</span><span>Inference</span><span>Status</span><span>Deployment</span><span>Gen.</span></div>
    ${rows}
  </section>`;
}

function renderEmpty(noClaws) {
  const blocked = state.data.runtime.mode === "unconfigured";
  return `<section class="empty"><div class="empty-mark">C</div><h3>${noClaws ? "No child cores yet" : "No matching claws"}</h3><p>${noClaws ? blocked ? "Configure Crabbox before creating the first child core." : "Create the first independent OpenClaw core." : "Adjust search or status filters."}</p>${noClaws ? `<button class="button primary" data-open-new ${blocked ? "disabled" : ""}>＋ New claw</button>` : ""}</section>`;
}

function renderTemplates() {
  const policies = state.data.policies || [];
  root.innerHTML = `${renderRuntimeBanner()}<section class="panel-grid">
    <div class="panel"><div class="panel-head"><div><p class="eyebrow">Executable desired state</p><h2>Policy library</h2></div><button class="button primary" data-new-policy>New policy</button></div>
      ${policies.length ? policies.map((policy, index) => renderPolicyCard(policy, index)).join("") : '<div class="empty"><h3>No policies yet</h3><p>Create an immutable policy version before a fleet rollout.</p><button class="button primary" data-new-policy>New policy</button></div>'}
    </div>
    <div class="panel"><div class="panel-head"><h2>Replication boundary</h2></div><div class="panel-body">
      <dl class="definition-list"><div><dt>Rollout</dt><dd>Field diff → generation CAS → canary → bounded reconcile</dd></div><div><dt>Rollback</dt><dd>Apply any earlier immutable version</dd></div><div><dt>Visibility</dt><dd>Native child DM pairing and group allowlists</dd></div><div><dt>Never copied</dt><dd>Secrets, OAuth, pairing, sessions, memory, agentDir</dd></div><div><dt>Drift signal</dt><dd>Desired generation ≠ observed generation</dd></div></dl>
    </div></div>
  </section>`;
}

function renderPolicyCard(policy, index) {
  const latest = policy.versions.at(-1);
  const applied = state.data.claws.filter((claw) =>
    claw.observed.phase !== "deleted" && claw.desired.templateId === policy.id
  );
  const current = applied.filter((claw) => claw.desired.templateVersion === latest.version).length;
  const spec = latest.spec;
  return `<article class="template-card policy-card">
    <span class="template-number">${String(index + 1).padStart(2, "0")}</span>
    <div><h3>${escapeHtml(policy.name)} <small>v${latest.version}</small></h3><p>${escapeHtml(policy.description || "No description")} · ${escapeHtml(shortModel(spec.inference.model))} · ${escapeHtml(visibilityLabel(spec.access))} · logs ${escapeHtml(spec.observability.logLevel)}</p></div>
    <div class="policy-card-actions"><code>${current} current · ${applied.length} assigned</code><span><button class="button small" data-version-policy="${escapeAttr(policy.id)}">New version</button><button class="button small primary" data-apply-policy="${escapeAttr(policy.id)}">Apply</button></span></div>
  </article>`;
}

function renderDeployments() {
  const active = state.data.claws.filter((claw) => claw.observed.phase !== "deleted");
  const runtime = state.data.runtime;
  const admissionOpen = runtime.targets.filter((target) => target.admissionOpen).length;
  const allocated = active.filter((claw) => claw.observed.lifecycle?.workspaceId).length;
  root.innerHTML = `${renderRuntimeBanner()}<section class="metrics">${metric("Provider", label(runtime.mode))}${metric("Targets", runtime.targets.length)}${metric("Admission open", admissionOpen, admissionOpen === runtime.targets.length ? "good" : "warn")}${metric(runtime.mode === "simulator" ? "Simulated records" : "Allocated", allocated, allocated ? "good" : "")}${metric("Node links", active.filter((c) => c.observed.controlLink.status === "paired").length, "good")}${metric("Default", runtime.defaultTarget)}</section>
    <section class="section-head"><div><h2>Placement targets</h2><p>Each target is an administrator-pinned Crabbox controller and appliance profile. Operators choose placement, never provider overrides.</p></div></section>
    <section class="panel" style="margin-top:12px">
      ${runtime.targets.map((target, index) => {
        const claws = active.filter((claw) => claw.desired.deployment.target === target.id);
        const targetAllocated = claws.filter((claw) => claw.observed.lifecycle?.workspaceId).length;
        return `<div class="template-card"><span class="template-number ${target.admissionOpen ? "" : "unavailable"}">${String(index + 1).padStart(2,"0")}</span><div><h3>${escapeHtml(target.label)} ${target.id === runtime.defaultTarget ? '<small>default</small>' : ""}</h3><p>${escapeHtml(target.region || "region unset")} · ${escapeHtml(target.profile)} · TTL ${escapeHtml(formatDuration(target.ttlSeconds))}${target.admissionOpen ? "" : ` · ${escapeHtml(target.message || "admission closed")}`}</p></div><code>${targetAllocated} allocated · ${target.admissionOpen ? "admission open" : "admission closed"}</code></div>`;
      }).join("")}
    </section>
    <section class="invariant-note"><b>Placement fence</b><span>Target, region, and profile are persisted atomically with the claw and become immutable after workspace allocation.</span></section>`;
}

function renderActivity() {
  const events = state.data.events || [];
  root.innerHTML = `${renderRuntimeBanner()}<section class="section-head" style="margin-top:0"><div><h2>Audit trail</h2><p>Lifecycle and policy metadata only. No prompts, messages, tool output, or credentials.</p></div><span class="status">Parent content capture off</span></section>
    <section class="activity-list" style="margin-top:14px">${events.length ? events.map((event) => `<article class="event"><time>${escapeHtml(formatTime(event.at))}</time><span class="actor">${escapeHtml(event.actor)}</span><div><strong>${escapeHtml(label(event.action.replace("claw.", "")))}</strong><p>${escapeHtml(event.summary)}</p></div><span class="event-outcome ${escapeAttr(event.outcome)}">${escapeHtml(event.outcome)}</span></article>`).join("") : '<div class="empty"><h3>No activity yet</h3></div>'}</section>`;
}

function handleViewClick(event) {
  if (event.target.closest("[data-retry-failed]")) {
    const failures = state.batchResult?.entries.filter((entry) => !entry.ok) || [];
    if (state.batchResult?.source === "github" && state.githubPreview) {
      renderGithubPreview();
      const failedIds = new Set(failures.map((entry) => entry.member.id));
      document.querySelectorAll('#github-preview input[name="githubMember"]:not(:disabled)').forEach((input) => {
        input.checked = failedIds.has(Number(input.value));
      });
      syncGithubSelection();
      githubDialog.showModal();
      return;
    }
    const form = document.querySelector("#bulk-form");
    const textarea = form?.querySelector('textarea[name="handles"]');
    if (textarea) textarea.value = failures.map((entry) => entry.handle).join("\n");
    for (const [name, value] of Object.entries(state.batchResult?.options || {})) {
      const control = form?.elements.namedItem(name);
      if (control && "value" in control) control.value = value;
    }
    syncDeploymentProfile(form);
    openCreateDialog(bulkDialog);
    return;
  }
  if (event.target.closest("[data-dismiss-batch]")) {
    state.batchResult = null;
    renderFleet();
    return;
  }
  const target = event.target.closest("[data-claw-id]");
  if (target) return openDrawer(target.dataset.clawId);
  if (event.target.closest("[data-open-new]")) return openCreateDialog(newDialog);
  if (event.target.closest("[data-open-template]")) return openTemplateDialog();
  if (event.target.closest("[data-new-policy]")) return openPolicyDialog();
  const versionPolicy = event.target.closest("[data-version-policy]")?.dataset.versionPolicy;
  if (versionPolicy) return openPolicyDialog(versionPolicy);
  const applyPolicyId = event.target.closest("[data-apply-policy]")?.dataset.applyPolicy;
  if (applyPolicyId) return openTemplateDialog(applyPolicyId);
}

function handleViewInput(event) {
  if (event.target.id === "fleet-search") {
    state.search = event.target.value;
    renderFleet();
    const input = document.querySelector("#fleet-search");
    input?.focus();
    input?.setSelectionRange(state.search.length, state.search.length);
  }
  if (event.target.id === "fleet-filter") {
    state.filter = event.target.value;
    renderFleet();
  }
}

function openDrawer(id) {
  const claw = state.data.claws.find((item) => item.id === id);
  if (!claw) return;
  state.selectedId = id;
  renderDrawer(claw);
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  void loadPairingQueue(id);
}

function closeDrawer() {
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  state.selectedId = null;
}

function renderDrawer(claw) {
  const phase = claw.observed.phase;
  const tone = statusTone(phase);
  const enabled = claw.desired.enabled;
  const drift = claw.desired.generation !== claw.observed.generation;
  const slackProbe = claw.observed.probes?.slack;
  const modelProbe = claw.observed.probes?.model;
  drawerContent.innerHTML = `<header class="drawer-head"><div class="drawer-head-row"><div><p class="eyebrow">Child core / ${escapeHtml(claw.desired.slug)}</p><h2>${escapeHtml(claw.desired.name)}</h2><span class="status ${tone}">${escapeHtml(phaseLabel(phase))}${drift ? " · drifted" : ""}</span></div><button class="icon-button" data-close-drawer aria-label="Close">×</button></div></header>
    <div class="drawer-body">
      <section class="detail-block"><h3>Readiness facets</h3><div class="detail-card readiness-list">
        ${readinessFacet("Provider", claw.observed.lifecycle?.workspaceId ? "observed" : "pending", claw.observed.lifecycle?.providerResourceId || claw.observed.lifecycle?.workspaceId || "No workspace allocation observed")}
        ${readinessFacet("Control node", claw.observed.controlLink.status, claw.observed.controlLink.nodeId || claw.observed.controlLink.command)}
        ${readinessFacet("Gateway", claw.observed.health === "healthy" ? "ready" : claw.observed.health, claw.observed.gatewayVersion || "Local readiness not observed")}
        ${readinessFacet("Managed policy", claw.observed.generation === claw.desired.generation && claw.observed.configHash ? "applied" : "drifted", `g${claw.observed.generation} / desired g${claw.desired.generation}`)}
        ${readinessFacet("Model authentication", modelProbe?.status || "pending", modelProbe ? `${modelProbe.configuredModel} · ${modelProbe.liveInferenceProbe ? "live inference probed" : "auth metadata only"}${modelProbe.missingProviders.length ? ` · missing ${modelProbe.missingProviders.join(", ")}` : ""}` : "Waiting for child model-auth status")}
        ${readinessFacet("Child log redaction", claw.observed.probes ? claw.observed.probes.diagnostics.redaction === "off" ? "warning" : "configured" : "pending", claw.observed.probes ? `Child setting: ${claw.observed.probes.diagnostics.redaction}; Crabhelm parent projection never stores content` : "Waiting for child diagnostics")}
        ${readinessFacet("Slack connection", !claw.desired.channels.slack.enabled ? "not requested" : !claw.desired.enabled ? "disabled" : slackProbe?.status || "pending", !claw.desired.channels.slack.enabled ? "No Slack connection desired" : !claw.desired.enabled ? "Connection configured; all child ingress disabled" : slackProbe ? `${slackProbe.accountCount} account${slackProbe.accountCount === 1 ? "" : "s"} · ${slackProbe.connected ? "connected" : "not connected"}${slackProbe.lastError ? ` · ${slackProbe.lastError}` : ""}` : "Waiting for native Slack live probe")}
        ${readinessFacet("Approved Slack user", claw.observed.userAccess?.status || "none", claw.observed.userAccess ? claw.observed.userAccess.label || claw.observed.userAccess.subjectId : claw.desired.channels.slack.enabled ? "Waiting for native Slack DM pairing" : "Enable the child Slack connection before pairing")}
      </div></section>
      <section class="detail-block"><h3>Current evidence</h3><div class="detail-card"><dl class="definition-list">
        <div><dt>Observed</dt><dd>g${claw.observed.generation} / desired g${claw.desired.generation}</dd></div>
        <div><dt>Gateway</dt><dd>${escapeHtml(claw.observed.gatewayVersion || "awaiting enrollment")}</dd></div>
        <div><dt>Health</dt><dd>${escapeHtml(claw.observed.health)} · ${escapeHtml(claw.observed.message)}</dd></div>
        <div><dt>Child policy hash</dt><dd>${escapeHtml((claw.observed.configHash || "not observed").slice(0, 18))}</dd></div>
        <div><dt>Child logging</dt><dd>${escapeHtml(claw.desired.observability.logLevel)} · parent audit metadata only</dd></div>
        <div><dt>Operational probe</dt><dd>${escapeHtml(claw.observed.probes ? relativeTime(claw.observed.probes.checkedAt) : "not observed")}</dd></div>
        <div><dt>Child process</dt><dd>${escapeHtml(claw.observed.probes ? `${formatBytes(claw.observed.probes.diagnostics.rssBytes)} RSS · ${formatDuration(claw.observed.probes.diagnostics.processUptimeSeconds)} uptime` : "not observed")}</dd></div>
        <div><dt>Log projection</dt><dd>${escapeHtml(claw.observed.probes ? `${claw.observed.probes.diagnostics.logLevel} · child redaction ${claw.observed.probes.diagnostics.redaction} · Crabhelm parent content capture off` : "not observed")}</dd></div>
        <div><dt>Crabbox</dt><dd>${escapeHtml(claw.observed.lifecycle?.providerResourceId || claw.observed.lifecycle?.workspaceId || "not allocated")}</dd></div>
      </dl></div></section>
      <section class="detail-block"><h3>Identity and access intent</h3><div class="detail-card">
        ${ownership("01", "Intended user", claw.desired.owner.label, `${claw.desired.owner.source} · access intent only`)}
        ${claw.observed.userAccess ? ownership("02", "Approved Slack user", "approved", claw.observed.userAccess.label || claw.observed.userAccess.subjectId) : ""}
        ${ownership("03", "Parent control", claw.observed.controlLink.status, `native node pairing · ${claw.observed.controlLink.command}`)}
        ${ownership("04", "Child ingress", claw.desired.access.dmPolicy, `${claw.desired.access.groupPolicy} groups · enforced by child`)}
        ${ownership("05", "Deployment owner", state.data.runtime.mode === "simulator" ? "Simulator" : "Crabbox", `${claw.desired.deployment.target} · ${claw.desired.deployment.region || "region unset"} · ${claw.desired.deployment.profile}`)}
        ${ownership("06", "Inference auth", claw.desired.inference.authRef || "child-local", claw.desired.inference.model)}
      </div></section>
      <section class="detail-block"><h3>Slack pairing queue</h3><div class="detail-card" id="pairing-queue"><p class="queue-note">Loading native child pairing requests…</p></div></section>
      <section class="detail-block"><h3>Edit desired state</h3><div class="detail-card"><form id="edit-claw-form" class="drawer-form">
        <label><span>Name</span><input name="name" maxlength="80" required value="${escapeAttr(claw.desired.name)}" /></label>
        <label><span>Model</span><select name="model">${modelOptions(claw.desired.inference.model)}</select></label>
        <label><span>Direct messages</span><select name="dmPolicy">${selectOptions(["pairing", "allowlist", "disabled"], claw.desired.access.dmPolicy)}</select></label>
        <label><span>Groups</span><select name="groupPolicy">${selectOptions(["allowlist", "disabled"], claw.desired.access.groupPolicy)}</select></label>
        <label><span>Child log level</span><select name="logLevel">${selectOptions(["error", "warn", "info", "debug"], claw.desired.observability.logLevel)}</select></label>
        <button class="button small" type="button" data-detail-action="save">Save desired state</button>
      </form></div></section>
      <section class="detail-block"><h3>Controls</h3><div class="detail-actions"><button class="button small" data-detail-action="reconcile">↻ Reconcile</button><button class="button small" data-detail-action="${enabled ? "disable" : "enable"}">${enabled ? "Disable ingress" : "Enable claw"}</button></div></section>
      <section class="delete-zone"><h3>Remove child core</h3><p>Disables ingress, waits for active runs to drain, releases the exact Crabbox workspace, confirms provider absence, then removes and verifies the exact native parent pairing. Type <b>${escapeHtml(claw.desired.name)}</b> to continue.</p><div class="delete-confirm"><input id="delete-confirmation" placeholder="${escapeAttr(claw.desired.name)}"/><button class="button danger small" data-detail-action="remove">Remove</button></div></section>
    </div>`;
}

function ownership(index, title, value, detail) {
  return `<div class="ownership-row"><span class="ownership-index">${index}</span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span><b>${escapeHtml(value)}</b></div>`;
}

function readinessFacet(title, status, detail) {
  const good = ["observed", "paired", "ready", "healthy", "applied", "enabled"].includes(status);
  const neutral = ["not requested", "disabled"].includes(status);
  return `<div class="readiness-row"><i class="${good ? "good" : neutral ? "neutral" : "warn"}"></i><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span><b>${escapeHtml(status)}</b></div>`;
}

async function handleDrawerClick(event) {
  if (event.target.closest("[data-close-drawer]")) return closeDrawer();
  const pairingButton = event.target.closest("[data-pairing-code]");
  if (pairingButton && state.selectedId) {
    try {
      pairingButton.disabled = true;
      await request(`/claws/${encodeURIComponent(state.selectedId)}/pairing/approve`, {
        method: "POST",
        body: JSON.stringify({
          channel: "slack",
          code: pairingButton.dataset.pairingCode,
          ...(pairingButton.dataset.accountId
            ? { accountId: pairingButton.dataset.accountId }
            : {}),
        }),
      });
      toast("Slack user paired through the child’s native allowlist");
      await loadState();
      if (state.selectedId) openDrawer(state.selectedId);
    } catch (error) {
      pairingButton.disabled = false;
      toast(error.message, true);
    }
    return;
  }
  const action = event.target.closest("[data-detail-action]")?.dataset.detailAction;
  if (!action || !state.selectedId) return;
  try {
    if (action === "remove") {
      const confirmation = document.querySelector("#delete-confirmation").value;
      const result = await request(`/claws/${encodeURIComponent(state.selectedId)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
      });
      toast(result.observed.phase === "deleted" ? "Provider absence confirmed; child removed" : `Removal staged: ${result.observed.deletion?.stage || result.observed.phase}`);
      if (result.observed.phase === "deleted") closeDrawer();
    } else if (action === "save") {
      const form = new FormData(document.querySelector("#edit-claw-form"));
      const result = await request(`/claws/${encodeURIComponent(state.selectedId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.get("name"),
          inference: { model: form.get("model") },
          access: { dmPolicy: form.get("dmPolicy"), groupPolicy: form.get("groupPolicy") },
          observability: { logLevel: form.get("logLevel") },
        }),
      });
      toast(result.observed.phase === "ready" ? "Desired state converged" : `Update submitted: ${label(result.observed.phase)}`);
    } else {
      const result = await request(`/claws/${encodeURIComponent(state.selectedId)}/${action}`, { method: "POST" });
      toast(action === "reconcile" ? `Reconciled: ${label(result.observed.phase)}` : `${label(action)} result: ${label(result.observed.phase)}`);
    }
    await loadState();
    if (state.selectedId) openDrawer(state.selectedId);
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadPairingQueue(id) {
  const container = document.querySelector("#pairing-queue");
  if (!container || state.selectedId !== id) return;
  const claw = state.data.claws.find((item) => item.id === id);
  if (!claw?.desired.channels.slack.enabled) {
    container.innerHTML = '<p class="queue-note">Slack is not enabled in desired state. Install child-local credentials and enable the connection before pairing a user.</p>';
    return;
  }
  try {
    const result = await request(`/claws/${encodeURIComponent(id)}/pairing?channel=slack`);
    if (state.selectedId !== id) return;
    container.innerHTML = result.requests.length
      ? result.requests.map((item) => `<div class="pairing-row"><span><strong>${escapeHtml(item.label || item.id)}</strong><small>${escapeHtml(item.accountId || "default account")} · ${escapeHtml(relativeTime(item.createdAt))}</small></span><button class="button small" data-pairing-code="${escapeAttr(item.code)}" ${item.accountId ? `data-account-id="${escapeAttr(item.accountId)}"` : ""}>Approve ${escapeHtml(item.code)}</button></div>`).join("")
      : '<p class="queue-note">No pending Slack DMs. The intended user must message the child first to receive a native pairing code.</p>';
  } catch (error) {
    container.innerHTML = `<p class="queue-note">${escapeHtml(error.message)}</p>`;
  }
}

async function createClaw(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const submit = document.querySelector("#create-submit");
  submit.disabled = true;
  try {
    const spec = {
      name: form.get("name"),
      owner: { subject: form.get("ownerSubject"), label: form.get("ownerLabel"), source: form.get("ownerSource") },
      deployment: deploymentSpec(form.get("deploymentTarget")),
      inference: { model: form.get("model") },
      slack: { enabled: form.get("slackEnabled") === "true", mode: "socket" },
      access: { dmPolicy: form.get("dmPolicy"), groupPolicy: form.get("groupPolicy") },
      observability: { logLevel: form.get("logLevel") },
    };
    const result = await request("/claws", { method: "POST", body: JSON.stringify(spec) });
    newDialog.close();
    event.currentTarget.reset();
    syncRuntimeActions();
    toast(createOutcome(result));
    await loadState();
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function createMaintainers(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const handles = [...new Set(
    String(form.get("handles") || "")
      .split(/\r?\n/)
      .map((value) => value.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
  )];
  if (!handles.length || handles.length > 50) {
    return toast("Enter between 1 and 50 GitHub handles", true);
  }
  const invalid = handles.find((handle) => !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/.test(handle));
  if (invalid) return toast(`Invalid GitHub handle: ${invalid}`, true);
  const submit = document.querySelector("#bulk-submit");
  submit.disabled = true;
  try {
    const batchOptions = {
      deploymentTarget: String(form.get("deploymentTarget")),
      model: String(form.get("model")),
      slackEnabled: String(form.get("slackEnabled")),
      dmPolicy: String(form.get("dmPolicy")),
      groupPolicy: String(form.get("groupPolicy")),
      logLevel: String(form.get("logLevel")),
    };
    const items = handles.map((handle) => ({
      name: `${handle} maintainer claw`,
      owner: { subject: `manual:github-handle:${handle}`, label: `@${handle}`, source: "manual" },
      deployment: deploymentSpec(batchOptions.deploymentTarget),
      inference: { model: batchOptions.model },
      slack: { enabled: batchOptions.slackEnabled === "true", mode: "socket" },
      access: { dmPolicy: batchOptions.dmPolicy, groupPolicy: batchOptions.groupPolicy },
      observability: { logLevel: batchOptions.logLevel },
    }));
    const result = await request("/claws/batch", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    state.batchResult = {
      ...result,
      source: "handles",
      options: batchOptions,
      entries: result.results.map((item, index) => ({ handle: handles[index], ...item })),
    };
    bulkDialog.close();
    event.currentTarget.reset();
    syncRuntimeActions();
    toast(
      result.failed
        ? `Created ${result.succeeded}/${result.requested}; ${result.failed} need correction`
        : `Created ${result.succeeded} maintainer claw${result.succeeded === 1 ? "" : "s"}`,
      result.failed > 0,
    );
    await loadState();
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

function openGithubDialog() {
  if (!state.data?.runtime.githubImport) {
    toast("Configure CRABHELM_GITHUB_TOKEN before organization import", true);
    return;
  }
  if (state.data.runtime.mode === "unconfigured") {
    toast("Configure Crabbox before provisioning child cores", true);
    return;
  }
  state.githubPreview = null;
  document.querySelector("#github-form").reset();
  syncRuntimeActions();
  syncGithubScope();
  renderGithubPreview();
  githubDialog.showModal();
}

function syncGithubScope() {
  const form = document.querySelector("#github-form");
  const scope = form.elements.namedItem("scope").value;
  const targetLabel = document.querySelector("#github-target-label");
  const target = form.elements.namedItem("target");
  const role = form.elements.namedItem("role");
  targetLabel.hidden = scope === "organization";
  target.required = scope !== "organization";
  if (scope === "team") {
    document.querySelector("#github-target-copy").textContent = "Team slug";
    target.placeholder = "core-maintainers";
    document.querySelector("#github-role-copy").textContent = "Team role";
    role.innerHTML = '<option value="all">All team members</option><option value="maintainer">Maintainers only</option><option value="member">Members only</option>';
  } else if (scope === "repository") {
    document.querySelector("#github-target-copy").textContent = "Repository";
    target.placeholder = "openclaw";
    document.querySelector("#github-role-copy").textContent = "Minimum permission";
    role.innerHTML = '<option value="maintain">Maintain or admin</option><option value="admin">Admins only</option>';
  } else {
    document.querySelector("#github-role-copy").textContent = "Organization role";
    role.innerHTML = '<option value="all">All members</option><option value="admin">Owners only</option><option value="member">Members only</option>';
  }
  state.githubPreview = null;
  renderGithubPreview();
}

function invalidateGithubPreview() {
  if (!state.githubPreview) return;
  state.githubPreview = null;
  renderGithubPreview();
}

async function previewGithubMembers() {
  const form = document.querySelector("#github-form");
  if (!form.reportValidity()) return;
  const scope = form.elements.namedItem("scope").value;
  const organization = form.elements.namedItem("organization").value;
  const target = form.elements.namedItem("target").value;
  const role = form.elements.namedItem("role").value;
  const button = document.querySelector("#github-preview-button");
  button.disabled = true;
  try {
    const query = scope === "team"
      ? { scope, organization, team: target, role }
      : scope === "repository"
        ? { scope, organization, repository: target, permission: role }
        : { scope, organization, role };
    state.githubPreview = await request("/import/github/preview", {
      method: "POST",
      body: JSON.stringify(query),
    });
    renderGithubPreview();
    toast(`Discovered ${state.githubPreview.members.length} GitHub member${state.githubPreview.members.length === 1 ? "" : "s"}`);
  } catch (error) {
    state.githubPreview = null;
    renderGithubPreview(error.message);
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderGithubPreview(error = "") {
  const container = document.querySelector("#github-preview");
  const button = document.querySelector("#github-import-button");
  if (error) {
    container.innerHTML = `<p class="error-copy">${escapeHtml(error)}</p>`;
    button.disabled = true;
    return;
  }
  if (!state.githubPreview) {
    container.innerHTML = "<p>Preview the source before choosing recipients.</p>";
    button.disabled = true;
    return;
  }
  const existing = new Set(state.data.claws.filter((claw) => claw.observed.phase !== "deleted").map((claw) => claw.desired.owner.subject));
  const rows = state.githubPreview.members.map((member) => {
    const subject = `github:id:${member.id}`;
    const exists = existing.has(subject);
    return `<label><input type="checkbox" name="githubMember" value="${member.id}" ${exists ? "disabled" : "checked"}/><span><strong>@${escapeHtml(member.login)}</strong><small>${escapeHtml(member.role || state.githubPreview.source.scope)} · id ${member.id}${exists ? " · already has a claw" : ""}</small></span></label>`;
  }).join("");
  container.innerHTML = `<div class="github-preview-head"><span>${state.githubPreview.members.length} discovered${state.githubPreview.truncated ? " · capped" : ""}</span><button class="button small" type="button" data-toggle-github>Toggle all</button></div><div class="github-member-list">${rows || "<p>No matching members.</p>"}</div>`;
  container.querySelector("[data-toggle-github]")?.addEventListener("click", () => {
    const enabled = [...container.querySelectorAll('input[name="githubMember"]:not(:disabled)')];
    const select = enabled.some((input) => !input.checked);
    enabled.forEach((input) => { input.checked = select; });
    syncGithubSelection();
  });
  syncGithubSelection();
}

function syncGithubSelection() {
  const count = document.querySelectorAll('#github-preview input[name="githubMember"]:checked').length;
  const button = document.querySelector("#github-import-button");
  button.disabled = count === 0;
  button.textContent = count ? `Import ${count} selected` : "Import selected";
}

async function importGithubMembers(event) {
  event.preventDefault();
  if (!state.githubPreview) return;
  const form = new FormData(event.currentTarget);
  const selected = new Set(form.getAll("githubMember").map(Number));
  const members = state.githubPreview.members.filter((member) => selected.has(member.id));
  if (!members.length) return toast("Select at least one GitHub member", true);
  const batchOptions = {
    deploymentTarget: String(form.get("deploymentTarget")),
    model: String(form.get("model")),
    slackEnabled: String(form.get("slackEnabled")),
    dmPolicy: String(form.get("dmPolicy")),
    groupPolicy: String(form.get("groupPolicy")),
    logLevel: String(form.get("logLevel")),
  };
  const createOptions = {
    target: batchOptions.deploymentTarget,
    model: batchOptions.model,
    slackEnabled: batchOptions.slackEnabled === "true",
    dmPolicy: batchOptions.dmPolicy,
    groupPolicy: batchOptions.groupPolicy,
    logLevel: batchOptions.logLevel,
  };
  const button = document.querySelector("#github-import-button");
  button.disabled = true;
  const aggregate = { requested: members.length, succeeded: 0, failed: 0, results: [] };
  try {
    for (let index = 0; index < members.length; index += 50) {
      const chunk = members.slice(index, index + 50);
      try {
        const result = await request("/import/github", {
          method: "POST",
          body: JSON.stringify({
            query: state.githubPreview.source,
            memberIds: chunk.map((member) => member.id),
            options: createOptions,
          }),
        });
        aggregate.succeeded += result.succeeded;
        aggregate.failed += result.failed;
        aggregate.results.push(...result.results);
      } catch (error) {
        const unknown = `outcome unknown; refresh before retry: ${error.message}`;
        aggregate.results.push(...chunk.map((member) => ({ ok: false, member, error: unknown })));
        const remaining = members.slice(index + chunk.length);
        aggregate.results.push(...remaining.map((member) => ({ ok: false, member, error: "not attempted after parent API failure" })));
        aggregate.failed += chunk.length + remaining.length;
        break;
      }
    }
    state.batchResult = {
      ...aggregate,
      source: "github",
      options: batchOptions,
      entries: aggregate.results.map((item, index) => ({
        handle: item.member?.login || members[index].login,
        member: item.member || members[index],
        ...item,
      })),
    };
    githubDialog.close();
    toast(aggregate.failed ? `Created ${aggregate.succeeded}/${aggregate.requested}; ${aggregate.failed} failed or unknown` : `Created ${aggregate.succeeded} GitHub child cores`, aggregate.failed > 0);
    await loadState();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function openTemplateDialog(policyId) {
  const policies = state.data?.policies || [];
  if (!policies.length) {
    setView("templates");
    toast("Create a policy before starting a rollout", true);
    return;
  }
  const policySelect = document.querySelector("#policy-apply-id");
  policySelect.innerHTML = policies.map((policy) => `<option value="${escapeAttr(policy.id)}">${escapeHtml(policy.name)}</option>`).join("");
  if (policyId && policies.some((policy) => policy.id === policyId)) policySelect.value = policyId;
  const targets = state.data.claws.filter((claw) => !["deleted", "deleting"].includes(claw.observed.phase));
  document.querySelector("#template-targets").innerHTML = targets.map((claw) => `<label><input type="checkbox" name="target" value="${escapeAttr(claw.id)}" checked /><span>${escapeHtml(claw.desired.name)}</span><small>${escapeHtml(claw.desired.inference.model)} · g${claw.desired.generation}</small></label>`).join("") || "<p>No eligible claws.</p>";
  syncPolicyVersions();
  syncCanaryOptions();
  invalidatePolicyPreview();
  templateDialog.showModal();
}

function syncPolicyVersions() {
  const policyId = document.querySelector("#policy-apply-id").value;
  const policy = state.data?.policies.find((item) => item.id === policyId);
  const versionSelect = document.querySelector("#policy-apply-version");
  versionSelect.innerHTML = policy
    ? [...policy.versions].reverse().map((version) => `<option value="${version.version}">v${version.version} · ${escapeHtml(shortModel(version.spec.inference.model))} · ${escapeHtml(visibilityLabel(version.spec.access))}</option>`).join("")
    : "";
  invalidatePolicyPreview();
}

function selectedPolicyTargets() {
  return [...document.querySelectorAll('#template-targets input[name="target"]:checked')].map((input) => input.value);
}

function syncCanaryOptions() {
  const ids = selectedPolicyTargets();
  const select = document.querySelector("#policy-canary");
  const previous = select.value;
  select.innerHTML = ids.map((id) => {
    const claw = state.data.claws.find((item) => item.id === id);
    return `<option value="${escapeAttr(id)}">${escapeHtml(claw?.desired.name || id)} · ${escapeHtml(phaseLabel(claw?.observed.phase || "unknown"))}</option>`;
  }).join("") || '<option value="">Select target claws first</option>';
  if (ids.includes(previous)) select.value = previous;
  select.disabled = ids.length < 2;
}

function invalidatePolicyPreview() {
  state.policyPreview = null;
  const container = document.querySelector("#policy-preview");
  if (container) container.innerHTML = "<p>Preview required. Generation checks prevent applying a stale diff.</p>";
  const submit = document.querySelector("#template-submit");
  if (submit) submit.disabled = true;
}

async function previewPolicy() {
  const policyId = document.querySelector("#policy-apply-id").value;
  const version = Number(document.querySelector("#policy-apply-version").value);
  const clawIds = selectedPolicyTargets();
  if (!clawIds.length) return toast("Select at least one claw", true);
  const button = document.querySelector("#policy-preview-button");
  button.disabled = true;
  try {
    state.policyPreview = await request(`/policies/${encodeURIComponent(policyId)}/preview`, {
      method: "POST",
      body: JSON.stringify({ version, clawIds }),
    });
    renderPolicyPreview(state.policyPreview);
    document.querySelector("#template-submit").disabled = false;
    toast(`Previewed ${state.policyPreview.targets.length} policy target${state.policyPreview.targets.length === 1 ? "" : "s"}`);
  } catch (error) {
    invalidatePolicyPreview();
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderPolicyPreview(preview, result) {
  const resultById = new Map((result?.results || []).map((item) => [item.clawId, item]));
  document.querySelector("#policy-preview").innerHTML = `<div class="policy-preview-head"><strong>${escapeHtml(preview.policyName)} v${preview.version}</strong><span>${preview.targets.reduce((sum, target) => sum + target.changes.length, 0)} field changes · generation fenced</span></div>
    <div class="policy-preview-rows">${preview.targets.map((target) => {
      const outcome = resultById.get(target.clawId);
      const changes = target.changes.length
        ? target.changes.map((change) => `<li><code>${escapeHtml(change.field)}</code><span>${escapeHtml(String(change.before))} → ${escapeHtml(String(change.after))}</span></li>`).join("")
        : "<li><span>No managed-field change; policy assignment may still update.</span></li>";
      return `<article><header><strong>${escapeHtml(target.clawName)}</strong><code>expected g${target.expectedGeneration}${outcome ? ` · ${outcome.ok ? "converged" : "failed"}${outcome.canary ? " canary" : ""}` : ""}</code></header><ul>${changes}</ul>${outcome?.error ? `<p class="error-copy">${escapeHtml(outcome.error)}</p>` : ""}</article>`;
    }).join("")}</div>`;
}

async function applyTemplate(event) {
  event.preventDefault();
  const preview = state.policyPreview;
  if (!preview) return toast("Preview the rollout before applying it", true);
  const clawIds = selectedPolicyTargets();
  if (clawIds.length !== preview.targets.length || clawIds.some((id) => !preview.targets.some((target) => target.clawId === id))) {
    invalidatePolicyPreview();
    return toast("Targets changed; preview the rollout again", true);
  }
  const canaryId = document.querySelector("#policy-canary").value;
  const submit = document.querySelector("#template-submit");
  submit.disabled = true;
  try {
    const result = await request(`/policies/${encodeURIComponent(preview.policyId)}/apply`, {
      method: "POST",
      body: JSON.stringify({
        version: preview.version,
        clawIds,
        expectedGenerations: Object.fromEntries(preview.targets.map((target) => [target.clawId, target.expectedGeneration])),
        ...(canaryId ? { canaryId } : {}),
      }),
    });
    renderPolicyPreview(preview, result);
    if (result.aborted) {
      toast("Canary did not converge; remaining claws were not changed", true);
    } else if (result.failed) {
      toast(`Policy applied; ${result.failed} claw${result.failed === 1 ? "" : "s"} remain drifted`, true);
    } else {
      toast(`Policy converged on ${result.succeeded} claw${result.succeeded === 1 ? "" : "s"}`);
      setTimeout(() => templateDialog.close(), 900);
    }
    await loadState();
  } catch (error) {
    invalidatePolicyPreview();
    toast(error.message, true);
  }
}

function openPolicyDialog(policyId) {
  const form = document.querySelector("#policy-form");
  form.reset();
  const policy = state.data?.policies.find((item) => item.id === policyId);
  const latest = policy?.versions.at(-1);
  form.elements.namedItem("policyId").value = policy?.id || "";
  form.elements.namedItem("name").value = policy?.name || "";
  form.elements.namedItem("name").disabled = Boolean(policy);
  form.elements.namedItem("description").value = policy?.description || "";
  if (latest) {
    form.elements.namedItem("model").value = latest.spec.inference.model;
    form.elements.namedItem("fallbackModels").value = latest.spec.inference.fallbackModels.join(", ");
    form.elements.namedItem("slackEnabled").value = String(latest.spec.slackEnabled);
    form.elements.namedItem("dmPolicy").value = latest.spec.access.dmPolicy;
    form.elements.namedItem("groupPolicy").value = latest.spec.access.groupPolicy;
    form.elements.namedItem("logLevel").value = latest.spec.observability.logLevel;
  }
  document.querySelector("#policy-form-title").textContent = policy ? `New ${policy.name} version` : "New policy";
  document.querySelector("#policy-form-eyebrow").textContent = policy ? `Current v${latest.version} · immutable history` : "Immutable managed policy";
  document.querySelector("#policy-save").textContent = policy ? `Create v${latest.version + 1}` : "Create policy v1";
  policyDialog.showModal();
}

async function savePolicy(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const policyId = String(form.get("policyId") || "");
  const fallbackModels = String(form.get("fallbackModels") || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const input = {
    description: String(form.get("description") || ""),
    spec: {
      inference: { model: String(form.get("model")), fallbackModels },
      slackEnabled: form.get("slackEnabled") === "true",
      access: { dmPolicy: String(form.get("dmPolicy")), groupPolicy: String(form.get("groupPolicy")) },
      observability: { logLevel: String(form.get("logLevel")) },
    },
  };
  const submit = document.querySelector("#policy-save");
  submit.disabled = true;
  try {
    const saved = await request(policyId ? `/policies/${encodeURIComponent(policyId)}/versions` : "/policies", {
      method: "POST",
      body: JSON.stringify(policyId ? input : { ...input, name: String(form.get("name")) }),
    });
    policyDialog.close();
    toast(`${saved.name} v${saved.versions.at(-1).version} created`);
    await loadState();
    setView("templates");
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function connectOperator(event) {
  event.preventDefault();
  const token = new FormData(event.currentTarget).get("token");
  state.token = String(token || "").trim();
  authDialog.close();
  try {
    await loadState();
    document.querySelector("#operator-state").textContent = "Connected";
    toast("Parent Gateway connected");
  } catch (error) {
    state.token = "";
    toast(error.message, true);
  }
}

function renderLoading() {
  root.innerHTML = '<div class="loading"><div class="loading-mark"></div><span>Reading parent-core state…</span></div>';
}

function renderError(message) {
  root.innerHTML = `<section class="empty"><div class="empty-mark">!</div><h3>Parent core unavailable</h3><p>${escapeHtml(message)}</p><button class="button primary" id="retry-button">Retry</button></section>`;
  document.querySelector("#retry-button")?.addEventListener("click", () => loadState());
}

function renderRuntimeBanner() {
  const runtime = state.data.runtime;
  if (runtime.mode === "simulator") {
    return '<section class="runtime-banner warning"><b>Simulation</b><span>No Crabbox resources or child Gateways exist. All health, node links, and lifecycle evidence on this screen are synthetic.</span></section>';
  }
  if (runtime.mode === "unconfigured") {
    return '<section class="runtime-banner danger"><b>Provisioning unavailable</b><span>No deployment target passes local URL, token, and fixed-profile admission checks.</span></section>';
  }
  if (runtime.mode === "partial") {
    return `<section class="runtime-banner warning"><b>Partial placement configuration</b><span>${runtime.targets.filter((target) => target.admissionOpen).length}/${runtime.targets.length} deployment targets pass local admission checks. Controller reachability is proven only by lifecycle operations.</span></section>`;
  }
  return `<section class="runtime-banner"><b>Crabbox targets configured</b><span>${runtime.targets.length} fixed deployment target${runtime.targets.length === 1 ? "" : "s"} pass local admission checks. Controller and child health remain lifecycle evidence.</span></section>`;
}

function renderBatchResult() {
  const result = state.batchResult;
  if (!result) return "";
  const failed = result.entries.filter((entry) => !entry.ok);
  return `<section class="batch-result ${failed.length ? "has-errors" : ""}">
    <div class="batch-result-head"><div><b>Maintainer batch</b><span>${result.succeeded}/${result.requested} created · ${result.failed} failed</span></div><div>${failed.length ? '<button class="button small" data-retry-failed>Retry failed</button>' : ""}<button class="icon-button" data-dismiss-batch aria-label="Dismiss batch result">×</button></div></div>
    <div class="batch-result-rows">${result.entries.map((entry) => `<div><code>@${escapeHtml(entry.handle)}</code><span class="event-outcome ${entry.ok ? "" : "failed"}">${entry.ok ? "created" : "failed"}</span><small>${escapeHtml(entry.ok ? phaseLabel(entry.claw.observed.phase) : entry.error)}</small></div>`).join("")}</div>
  </section>`;
}

function syncRuntimeActions() {
  const blocked = state.data?.runtime?.mode === "unconfigured";
  document.querySelector("#new-button").disabled = blocked;
  document.querySelector("#bulk-button").disabled = blocked;
  document.querySelector("#github-button").disabled = blocked || !state.data.runtime.githubImport;
  document.querySelector("#new-button").title = blocked ? "Configure Crabbox before provisioning" : "";
  document.querySelector("#bulk-button").title = blocked ? "Configure Crabbox before provisioning" : "";
  document.querySelector("#github-button").title = !state.data.runtime.githubImport ? "Configure CRABHELM_GITHUB_TOKEN" : blocked ? "Configure Crabbox before provisioning" : "";
  document.querySelectorAll("[data-deployment-target]").forEach((select) => {
    const previous = select.value;
    select.innerHTML = state.data.runtime.targets.map((target) => `<option value="${escapeAttr(target.id)}" ${target.admissionOpen ? "" : "disabled"}>${escapeHtml(target.label)} · ${escapeHtml(target.region || target.id)}${target.admissionOpen ? "" : " · admission closed"}</option>`).join("");
    const previousTarget = state.data.runtime.targets.find((target) => target.id === previous && target.admissionOpen);
    const defaultTarget = state.data.runtime.targets.find((target) => target.id === state.data.runtime.defaultTarget);
    if (previousTarget) {
      select.value = previousTarget.id;
    } else if (defaultTarget?.admissionOpen) {
      select.value = defaultTarget.id;
    } else {
      select.insertAdjacentHTML("afterbegin", '<option value="" selected disabled>Default admission closed · choose a target</option>');
      select.value = "";
    }
    syncDeploymentProfile(select.closest("form"));
  });
}

function syncDeploymentProfile(form) {
  if (!form || !state.data) return;
  const id = form.querySelector("[data-deployment-target]")?.value;
  const target = state.data.runtime.targets.find((item) => item.id === id);
  const profile = form.querySelector("[data-deployment-profile]");
  if (profile && target) profile.innerHTML = `<option>${escapeHtml(label(target.profile))} · fixed by ${escapeHtml(target.label)}</option>`;
}

function deploymentSpec(id) {
  const target = state.data.runtime.targets.find((item) => item.id === String(id));
  if (!target || !target.admissionOpen) throw new Error(`Deployment target ${id || ""} is unavailable`);
  return {
    target: target.id,
    profile: target.profile,
    ...(target.region ? { region: target.region } : {}),
  };
}

function openCreateDialog(dialog) {
  if (state.data?.runtime?.mode === "unconfigured") {
    toast("Configure Crabbox before provisioning child cores", true);
    return;
  }
  syncRuntimeActions();
  dialog.showModal();
}

function createOutcome(claw) {
  if (state.data.runtime.mode === "simulator" && claw.observed.phase === "ready") {
    return "Simulated child record is ready; no infrastructure was created";
  }
  if (claw.observed.phase === "enrolling") return "Workspace requested; waiting for child node enrollment";
  if (claw.observed.phase === "attention") return `Create needs attention: ${claw.observed.message}`;
  return `Create result: ${label(claw.observed.phase)}`;
}

function modelOptions(current) {
  return ["openai/gpt-5.5", "openai/gpt-5.5-mini", "anthropic/claude-sonnet-4.6"]
    .map((model) => `<option value="${escapeAttr(model)}" ${model === current ? "selected" : ""}>${escapeHtml(label(model))}</option>`)
    .join("");
}

function selectOptions(values, current) {
  return values.map((value) => `<option value="${escapeAttr(value)}" ${value === current ? "selected" : ""}>${escapeHtml(label(value))}</option>`).join("");
}


function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast ${error ? "error" : ""}`;
  element.innerHTML = `<b>${error ? "Error" : "Crabhelm"}</b>${escapeHtml(message)}`;
  document.querySelector("#toasts").append(element);
  setTimeout(() => element.remove(), 3800);
}

function statusTone(phase) {
  if (phase === "ready") return "ready";
  if (["requested", "provisioning", "enrolling", "deleting"].includes(phase)) return "warning";
  if (phase === "attention") return "attention";
  return "offline";
}

function shortModel(model) { return model.includes("/") ? model.split("/").slice(1).join("/") : model; }
function visibilityLabel(access) {
  if (access.dmPolicy === "disabled" && access.groupPolicy === "disabled") return "no channel ingress";
  if (access.dmPolicy === "pairing" && access.groupPolicy === "allowlist") return "paired + allowlisted";
  if (access.dmPolicy === "pairing") return "paired DMs";
  if (access.dmPolicy === "allowlist" && access.groupPolicy === "allowlist") return "allowlists only";
  return `${access.dmPolicy} DMs · ${access.groupPolicy} groups`;
}
function label(value) { return String(value).replace(/[._-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()); }
function phaseLabel(value) { return value === "ready" ? "Policy converged" : label(value); }
function formatDuration(seconds) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function formatTime(value) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function escapeAttr(value) { return escapeHtml(value); }
