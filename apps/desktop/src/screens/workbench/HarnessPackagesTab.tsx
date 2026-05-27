import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentProfile,
  AgentProviderStatusMap,
  Capability,
  HarnessAgentProfileBinding,
  HarnessBindingSet,
  HarnessDefinition,
  HarnessPackageExportProposalResult,
  HarnessPackageExportPreview,
  HarnessSourceFormat,
  HarnessPipelineDraftPreviewResult,
  McpServerConfig,
  SkillSource,
} from "@harness/core";
import { WORKER_OUTPUT_CONTRACTS } from "@harness/core";
import {
  assessHarnessBindingReadiness,
  createAgentProfileInputFromHarnessCandidate,
  harnessAgentBindingCandidates,
  harnessWorkflowStepRows,
  primaryHarnessPackageIssue,
  repairDraftFromWorkflow,
  repairInputFromDraft,
  suggestHarnessProfileBinding,
  summarizeHarnessPackage,
  validateHarnessWorkflowRepairDraft,
  type HarnessAgentBindingCandidate,
  type HarnessWorkflowRepairDraft,
  type HarnessWorkflowStepRepairDraft,
} from "./harness-package-ui";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; packages: HarnessDefinition[] }
  | { kind: "error"; message: string };

type ProfileListState =
  | { kind: "loading" }
  | { kind: "ready"; profiles: AgentProfile[] }
  | { kind: "error"; message: string };

type ReadinessListState =
  | { kind: "loading" }
  | {
      kind: "ready";
      providers: AgentProviderStatusMap;
      mcpServers: McpServerConfig[];
      skillSources: SkillSource[];
      capabilities: Capability[];
    }
  | { kind: "error"; message: string };

type ExportTargetFormat = Extract<
  HarnessSourceFormat,
  "claude" | "codex" | "harness-native"
>;

interface Notice {
  kind: "success" | "warning" | "error";
  message: string;
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const formatTimestamp = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
};

const issueText = (definition: HarnessDefinition): string => {
  const issue = primaryHarnessPackageIssue(definition);
  if (!issue) return "No validation issues";
  return `${issue.code}: ${issue.message}`;
};

export const HarnessPackagesTab = (): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [profileList, setProfileList] = useState<ProfileListState>({
    kind: "loading",
  });
  const [readinessList, setReadinessList] = useState<ReadinessListState>({
    kind: "loading",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null,
  );
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [bindingSets, setBindingSets] = useState<HarnessBindingSet[]>([]);
  const [bindingSetName, setBindingSetName] = useState("");
  const [preview, setPreview] =
    useState<HarnessPipelineDraftPreviewResult | null>(null);
  const [exportTarget, setExportTarget] =
    useState<ExportTargetFormat>("harness-native");
  const [exportPreview, setExportPreview] =
    useState<HarnessPackageExportPreview | null>(null);
  const [exportProposal, setExportProposal] =
    useState<HarnessPackageExportProposalResult | null>(null);
  const [repairDraft, setRepairDraft] =
    useState<HarnessWorkflowRepairDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [creatingProfileRef, setCreatingProfileRef] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = useCallback(async () => {
    try {
      const packages = await window.harness.harnessPackages.list();
      setList({ kind: "ready", packages });
    } catch (e) {
      setList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    try {
      const profiles = await window.harness.agents.list();
      setProfileList({ kind: "ready", profiles });
    } catch (e) {
      setProfileList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  const refreshReadiness = useCallback(async () => {
    try {
      const [providers, mcpServers, skillSources, capabilities] =
        await Promise.all([
          window.harness.agent.checkProviders(),
          window.harness.mcp.list(),
          window.harness.skillSource.list(),
          window.harness.capability.list(),
        ]);
      setReadinessList({
        kind: "ready",
        providers,
        mcpServers,
        skillSources,
        capabilities,
      });
    } catch (e) {
      setReadinessList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  const refreshBindingSets = useCallback(async () => {
    try {
      const sets = await window.harness.harnessPackages.listBindingSets();
      setBindingSets(sets);
    } catch {
      setBindingSets([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  useEffect(() => {
    void refreshReadiness();
  }, [refreshReadiness]);

  useEffect(() => {
    void refreshBindingSets();
  }, [refreshBindingSets]);

  useEffect(() => {
    if (list.kind !== "ready") return;
    if (selectedId === null && list.packages.length > 0) {
      setSelectedId(list.packages[0]!.id);
      return;
    }
    if (
      selectedId !== null &&
      !list.packages.some((item) => item.id === selectedId)
    ) {
      setSelectedId(list.packages[0]?.id ?? null);
    }
  }, [list, selectedId]);

  const selectedPackage = useMemo(() => {
    if (list.kind !== "ready" || selectedId === null) return null;
    return list.packages.find((item) => item.id === selectedId) ?? null;
  }, [list, selectedId]);

  const selectedSummary = selectedPackage
    ? summarizeHarnessPackage(selectedPackage)
    : null;

  const selectedWorkflow = useMemo(() => {
    if (!selectedPackage) return null;
    return (
      selectedPackage.workflows.find(
        (workflow) => workflow.id === selectedWorkflowId,
      ) ??
      selectedPackage.workflows[0] ??
      null
    );
  }, [selectedPackage, selectedWorkflowId]);

  const selectedBindingSets = useMemo(() => {
    if (!selectedPackage || !selectedWorkflow) return [];
    return bindingSets.filter(
      (set) =>
        set.packageId === selectedPackage.id &&
        set.workflowId === selectedWorkflow.id,
    );
  }, [bindingSets, selectedPackage, selectedWorkflow]);

  const bindingCandidates = useMemo(
    () =>
      selectedPackage
        ? harnessAgentBindingCandidates(selectedPackage, selectedWorkflowId)
        : [],
    [selectedPackage, selectedWorkflowId],
  );

  const workflowStepRows = useMemo(
    () => (selectedWorkflow ? harnessWorkflowStepRows(selectedWorkflow) : []),
    [selectedWorkflow],
  );

  const repairIssues = useMemo(
    () =>
      repairDraft ? validateHarnessWorkflowRepairDraft(repairDraft) : [],
    [repairDraft],
  );

  const bindingReadiness = useMemo(() => {
    if (!selectedPackage || profileList.kind !== "ready") return null;
    return assessHarnessBindingReadiness({
      definition: selectedPackage,
      workflowId: selectedWorkflowId,
      bindings,
      profiles: profileList.profiles,
      ...(readinessList.kind === "ready"
        ? {
            providers: readinessList.providers,
            mcpServers: readinessList.mcpServers,
            skillSources: readinessList.skillSources,
            capabilities: readinessList.capabilities,
          }
        : {}),
    });
  }, [bindings, profileList, readinessList, selectedPackage, selectedWorkflowId]);

  useEffect(() => {
    if (!selectedPackage) {
      setSelectedWorkflowId(null);
      setBindings({});
      setPreview(null);
      setExportPreview(null);
      setExportProposal(null);
      setRepairDraft(null);
      return;
    }
    const nextWorkflowId = selectedPackage.workflows[0]?.id ?? null;
    setSelectedWorkflowId(nextWorkflowId);
    setPreview(null);
    if (profileList.kind !== "ready") {
      setBindings({});
      return;
    }
    const candidates = harnessAgentBindingCandidates(
      selectedPackage,
      nextWorkflowId,
    );
    setBindings(
      Object.fromEntries(
        candidates.map((candidate) => [
          candidate.harnessAgentRef,
          suggestHarnessProfileBinding(candidate, profileList.profiles),
        ]),
      ),
    );
  }, [selectedPackage?.id, profileList]);

  useEffect(() => {
    setRepairDraft(
      selectedWorkflow ? repairDraftFromWorkflow(selectedWorkflow) : null,
    );
  }, [selectedPackage?.id, selectedWorkflow?.id]);

  useEffect(() => {
    if (!selectedPackage || !selectedWorkflow) {
      setBindingSetName("");
      return;
    }
    setBindingSetName(`${selectedPackage.name} / ${selectedWorkflow.name}`);
  }, [selectedPackage?.id, selectedWorkflow?.id]);

  const updateWorkflowSelection = (workflowId: string): void => {
    setSelectedWorkflowId(workflowId);
    setPreview(null);
    if (!selectedPackage || profileList.kind !== "ready") {
      setBindings({});
      return;
    }
    const candidates = harnessAgentBindingCandidates(
      selectedPackage,
      workflowId,
    );
    setBindings(
      Object.fromEntries(
        candidates.map((candidate) => [
          candidate.harnessAgentRef,
          suggestHarnessProfileBinding(candidate, profileList.profiles),
        ]),
      ),
    );
  };

  const handleBindingChange = (
    harnessAgentRef: string,
    agentProfileId: string,
  ): void => {
    setPreview(null);
    setBindings((current) => ({
      ...current,
      [harnessAgentRef]: agentProfileId,
    }));
  };

  const handleCreateProfileForBinding = async (
    candidate: HarnessAgentBindingCandidate,
  ): Promise<void> => {
    if (profileList.kind !== "ready") return;
    setCreatingProfileRef(candidate.harnessAgentRef);
    setNotice(null);
    try {
      const created = await window.harness.agents.create({
        profile: createAgentProfileInputFromHarnessCandidate(candidate),
      });
      await refreshProfiles();
      setPreview(null);
      setBindings((current) => ({
        ...current,
        [candidate.harnessAgentRef]: created.id,
      }));
      setNotice({
        kind: "success",
        message: `${created.name} AgentProfile을 생성하고 ${candidate.label}에 바인딩했습니다.`,
      });
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setCreatingProfileRef(null);
    }
  };

  const updateRepairNote = (note: string): void => {
    setRepairDraft((current) => (current ? { ...current, note } : current));
  };

  const updateRepairStep = (
    stepId: string,
    patch: Partial<Omit<HarnessWorkflowStepRepairDraft, "stepId">>,
  ): void => {
    setPreview(null);
    setRepairDraft((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step) =>
              step.stepId === stepId ? { ...step, ...patch } : step,
            ),
          }
        : current,
    );
  };

  const previewBindings = (): HarnessAgentProfileBinding[] =>
    bindingCandidates
      .map((candidate) => ({
        harnessAgentRef: candidate.harnessAgentRef,
        agentProfileId: bindings[candidate.harnessAgentRef] ?? "",
      }))
      .filter((binding) => binding.agentProfileId.length > 0);

  const handlePreviewPipelineDraft = async (): Promise<void> => {
    if (!selectedPackage) return;
    setPreviewBusy(true);
    setNotice(null);
    try {
      const result =
        await window.harness.harnessPackages.previewPipelineDraft({
          packageId: selectedPackage.id,
          ...(selectedWorkflowId ? { workflowId: selectedWorkflowId } : {}),
          bindings: previewBindings(),
          ...(readinessList.kind === "ready"
            ? { providers: readinessList.providers }
            : {}),
        });
      setPreview(result);
      if (result.ok) {
        setNotice({
          kind: result.issues.length > 0 ? "warning" : "success",
          message: `${result.pipeline.name} preview ready.`,
        });
      } else {
        setNotice({
          kind: "warning",
          message: result.issues.map((issue) => issue.message).join(" "),
        });
      }
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setPreviewBusy(false);
    }
  };

  const handleSaveBindingSet = async (): Promise<void> => {
    if (!selectedPackage || !selectedWorkflow) return;
    const name = bindingSetName.trim();
    if (name.length === 0) {
      setNotice({ kind: "warning", message: "Binding set name is required." });
      return;
    }
    if ((bindingReadiness?.errorCount ?? 0) > 0) {
      setNotice({
        kind: "warning",
        message: "Resolve binding errors before saving a direct harness route.",
      });
      return;
    }
    setPreviewBusy(true);
    setNotice(null);
    try {
      const existing = selectedBindingSets.find(
        (set) => set.name.trim().toLowerCase() === name.toLowerCase(),
      );
      const saved = await window.harness.harnessPackages.saveBindingSet({
        bindingSet: existing
          ? {
              ...existing,
              name,
              bindings: previewBindings(),
            }
          : {
              packageId: selectedPackage.id,
              workflowId: selectedWorkflow.id,
              name,
              bindings: previewBindings(),
            },
      });
      await refreshBindingSets();
      setNotice({
        kind: "success",
        message: `${saved.name} binding set saved for direct harness orchestration.`,
      });
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setPreviewBusy(false);
    }
  };

  const handleCreatePipelineTemplate = async (): Promise<void> => {
    if (!preview?.ok) return;
    setPreviewBusy(true);
    setNotice(null);
    try {
      const saved = await window.harness.pipeline.create({
        pipeline: preview.pipeline,
      });
      setNotice({
        kind: "success",
        message: `${saved.name} pipeline template saved.`,
      });
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setPreviewBusy(false);
    }
  };

  const handlePreviewExport = async (): Promise<void> => {
    if (!selectedPackage) return;
    setExportBusy(true);
    setNotice(null);
    try {
      const result = await window.harness.harnessPackages.previewExport({
        packageId: selectedPackage.id,
        targetFormat: exportTarget,
      });
      setExportPreview(result);
      setExportProposal(null);
      setNotice({
        kind: result.warnings.length > 0 ? "warning" : "success",
        message: `${result.targetFormat} export preview ready: ${result.files.length} files.`,
      });
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setExportBusy(false);
    }
  };

  const handleProposeExport = async (): Promise<void> => {
    if (!selectedPackage) return;
    setExportBusy(true);
    setNotice(null);
    try {
      const targetDir = await window.harness.app.selectDirectory();
      if (!targetDir) return;
      const result = await window.harness.harnessPackages.proposeExport({
        packageId: selectedPackage.id,
        targetFormat: exportTarget,
        targetDir,
      });
      setExportPreview(result.preview);
      setExportProposal(result);
      setNotice({
        kind: "success",
        message: `${result.approvals.length} export file approvals created.`,
      });
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setExportBusy(false);
    }
  };

  const handleSaveRepairSnapshot = async (): Promise<void> => {
    if (!selectedPackage || !selectedWorkflow || !repairDraft) return;
    const issues = validateHarnessWorkflowRepairDraft(repairDraft);
    if (issues.length > 0) {
      setNotice({ kind: "warning", message: issues[0]! });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.harness.harnessPackages.repair(
        repairInputFromDraft(selectedPackage.id, repairDraft),
      );
      setNotice({
        kind: "success",
        message: `${result.definition.name} repaired snapshot saved.`,
      });
      setSelectedId(result.definition.id);
      setSelectedWorkflowId(selectedWorkflow.id);
      setPreview(null);
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleImportDirectory = async (): Promise<void> => {
    setNotice(null);
    setBusy(true);
    try {
      const rootDir = await window.harness.app.selectDirectory();
      if (!rootDir) return;
      const result = await window.harness.harnessPackages.importDirectory({
        rootDir,
      });
      if (result.ok) {
        setNotice({
          kind:
            result.definition.validation.status === "needs_review"
              ? "warning"
              : "success",
          message: `${result.definition.name} imported as ${result.definition.source.format}.`,
        });
        setSelectedId(result.definition.id);
      } else {
        setNotice({
          kind: "warning",
          message: result.issues.map((issue) => issue.message).join(" "),
        });
      }
      await refresh();
      await refreshBindingSets();
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (definition: HarnessDefinition): Promise<void> => {
    if (!window.confirm(`"${definition.name}" package snapshot을 제거하시겠습니까?`)) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await window.harness.harnessPackages.remove({
        packageId: definition.id,
      });
      setNotice({
        kind: "success",
        message: `${definition.name} removed from registry.`,
      });
      setSelectedId(null);
      await refresh();
      await refreshBindingSets();
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="harness-packages-tab">
      <div className="harness-packages-tab__banner" role="note">
        <strong>Harness Packages</strong>
        <span>Claude, Codex, Harness-native metadata snapshots</span>
      </div>

      {notice && (
        <div
          className={`harness-packages-tab__notice harness-packages-tab__notice--${notice.kind}`}
        >
          {notice.message}
        </div>
      )}

      <div className="harness-packages-tab__split">
        <aside className="harness-packages-tab__list">
          <header className="harness-packages-tab__list-header">
            <span>Packages</span>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void handleImportDirectory()}
              disabled={busy}
            >
              {busy ? "Importing..." : "Import"}
            </button>
          </header>

          {list.kind === "loading" && (
            <div className="empty-state">불러오는 중...</div>
          )}
          {list.kind === "error" && (
            <div
              className="empty-state"
              style={{ color: "var(--status-failed)" }}
            >
              {list.message}
            </div>
          )}
          {list.kind === "ready" && list.packages.length === 0 && (
            <div className="empty-state">등록된 harness package가 없습니다.</div>
          )}
          {list.kind === "ready" && (
            <ul className="harness-packages-tab__items">
              {list.packages.map((definition) => {
                const summary = summarizeHarnessPackage(definition);
                return (
                  <li key={definition.id}>
                    <button
                      type="button"
                      className={`harness-packages-tab__item${
                        selectedId === definition.id
                          ? " harness-packages-tab__item--selected"
                          : ""
                      }`}
                      onClick={() => setSelectedId(definition.id)}
                    >
                      <span className="harness-packages-tab__item-name">
                        {definition.name}
                      </span>
                      <span className="harness-packages-tab__item-meta">
                        {summary.formatLabel} · {summary.statusLabel}
                      </span>
                      <span className="harness-packages-tab__item-meta">
                        {summary.skills} skills · {summary.agents} agents ·{" "}
                        {summary.workflows} workflows
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="harness-packages-tab__detail">
          {selectedPackage === null || selectedSummary === null ? (
            <div className="empty-state">
              Harness package snapshot을 import하거나 선택하세요.
            </div>
          ) : (
            <div className="harness-packages-tab__detail-inner">
              <header className="harness-packages-tab__detail-header">
                <div>
                  <h3>{selectedPackage.name}</h3>
                  <code title={selectedPackage.source.rootDir}>
                    {selectedPackage.source.rootDir}
                  </code>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--danger"
                  onClick={() => void handleRemove(selectedPackage)}
                  disabled={busy}
                >
                  Remove
                </button>
              </header>

              <div className="harness-packages-tab__badges">
                <span>{selectedSummary.formatLabel}</span>
                <span
                  className={`harness-packages-tab__status harness-packages-tab__status--${selectedPackage.validation.status}`}
                >
                  {selectedSummary.statusLabel}
                </span>
                {selectedSummary.blocksExecution && (
                  <span className="harness-packages-tab__status harness-packages-tab__status--blocked">
                    Execution blocked
                  </span>
                )}
                {selectedPackage.repair && (
                  <span title={selectedPackage.repair.sourcePackageId}>
                    Repaired {formatTimestamp(selectedPackage.repair.repairedAt)}
                  </span>
                )}
              </div>

              <dl className="harness-packages-tab__metrics">
                <div>
                  <dt>Files</dt>
                  <dd>{selectedSummary.files}</dd>
                </div>
                <div>
                  <dt>Skills</dt>
                  <dd>{selectedSummary.skills}</dd>
                </div>
                <div>
                  <dt>Agents</dt>
                  <dd>{selectedSummary.agents}</dd>
                </div>
                <div>
                  <dt>Workflows</dt>
                  <dd>{selectedSummary.workflows}</dd>
                </div>
                <div>
                  <dt>Capabilities</dt>
                  <dd>{selectedSummary.capabilities}</dd>
                </div>
                <div>
                  <dt>Imported</dt>
                  <dd>{formatTimestamp(selectedPackage.source.importedAt)}</dd>
                </div>
              </dl>

              <section className="harness-packages-tab__section">
                <h4>Overview</h4>
                <p>{selectedPackage.overview.summary || selectedPackage.name}</p>
              </section>

              <section className="harness-packages-tab__section">
                <h4>Validation</h4>
                {selectedPackage.validation.issues.length === 0 ? (
                  <p>No validation issues.</p>
                ) : (
                  <>
                    <p>{issueText(selectedPackage)}</p>
                    <ul className="harness-packages-tab__issues">
                      {selectedPackage.validation.issues.map((issue, index) => (
                        <li key={`${issue.code}-${index}`}>
                          <span>{issue.severity}</span>
                          <strong>{issue.code}</strong>
                          <p>{issue.message}</p>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>

              <section className="harness-packages-tab__section">
                <div className="harness-packages-tab__section-heading">
                  <h4>Export Preview</h4>
                  <div className="harness-packages-tab__actions">
                    <select
                      value={exportTarget}
                      onChange={(event) => {
                        setExportTarget(
                          event.currentTarget.value as ExportTargetFormat,
                        );
                        setExportPreview(null);
                        setExportProposal(null);
                      }}
                      disabled={exportBusy}
                    >
                      <option value="harness-native">Harness native</option>
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                    </select>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => void handlePreviewExport()}
                      disabled={exportBusy}
                    >
                      {exportBusy ? "Previewing..." : "Preview"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={() => void handleProposeExport()}
                      disabled={exportBusy}
                    >
                      Propose Write
                    </button>
                  </div>
                </div>
                {exportPreview === null ? (
                  <p>Generate a declaration-only compatibility projection.</p>
                ) : (
                  <div className="harness-packages-tab__preview harness-packages-tab__preview--ok">
                    <p>
                      {exportPreview.targetFormat} · {exportPreview.files.length}{" "}
                      files · {exportPreview.warnings.length} warnings
                    </p>
                    {exportPreview.warnings.length > 0 && (
                      <ul className="harness-packages-tab__issues">
                        {exportPreview.warnings.map((warning, index) => (
                          <li key={`export-warning-${index}`}>
                            <span>warning</span>
                            <strong>EXPORT_PROJECTION_WARNING</strong>
                            <p>{warning}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                    <ul className="harness-packages-tab__compact-list">
                      {exportPreview.files.map((file) => (
                        <li key={file.relativePath}>
                          <strong>{file.relativePath}</strong>
                          <span>
                            {file.kind} · {file.content.length} bytes
                          </span>
                        </li>
                      ))}
                    </ul>
                    {exportProposal !== null && (
                      <div className="harness-packages-tab__approval-batch">
                        <h5>Approval Batch</h5>
                        <dl className="harness-packages-tab__approval-metrics">
                          <div>
                            <dt>Target</dt>
                            <dd>{exportProposal.targetDir}</dd>
                          </div>
                          <div>
                            <dt>TaskRun</dt>
                            <dd>{exportProposal.taskRun.status}</dd>
                          </div>
                          <div>
                            <dt>Checkpoint</dt>
                            <dd>{exportProposal.checkpoint.reason}</dd>
                          </div>
                          <div>
                            <dt>Approvals</dt>
                            <dd>{exportProposal.approvals.length}</dd>
                          </div>
                        </dl>
                        <ul className="harness-packages-tab__compact-list">
                          {exportProposal.approvals.map((approval) => (
                            <li key={approval.id}>
                              <strong>
                                {approval.proposedAction?.filePatch?.path ??
                                  approval.actionSummary}
                              </strong>
                              <span>
                                {approval.status} · {approval.actionType}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="harness-packages-tab__section">
                <div className="harness-packages-tab__section-heading">
                  <h4>Pipeline Draft</h4>
                  <div className="harness-packages-tab__actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => void handleSaveBindingSet()}
                      disabled={
                        previewBusy ||
                        selectedWorkflow === null ||
                        (bindingReadiness?.errorCount ?? 0) > 0
                      }
                    >
                      {previewBusy ? "Saving..." : "Save Binding Set"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => void handlePreviewPipelineDraft()}
                      disabled={
                        previewBusy ||
                        selectedWorkflow === null ||
                        (bindingReadiness?.errorCount ?? 0) > 0
                      }
                    >
                      {previewBusy ? "Previewing..." : "Preview"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={() => void handleCreatePipelineTemplate()}
                      disabled={previewBusy || !preview?.ok}
                    >
                      Save Template
                    </button>
                  </div>
                </div>

                {selectedPackage.workflows.length === 0 ? (
                  <p>No parsed workflows.</p>
                ) : (
                  <div className="harness-packages-tab__draft">
                    <label className="harness-packages-tab__field">
                      <span>Workflow</span>
                      <select
                        value={selectedWorkflow?.id ?? ""}
                        onChange={(event) =>
                          updateWorkflowSelection(event.currentTarget.value)
                        }
                      >
                        {selectedPackage.workflows.map((workflow) => (
                          <option key={workflow.id} value={workflow.id}>
                            {workflow.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="harness-packages-tab__field">
                      <span>Binding set</span>
                      <input
                        value={bindingSetName}
                        onChange={(event) =>
                          setBindingSetName(event.currentTarget.value)
                        }
                        placeholder="Question-time route name"
                      />
                    </label>

                    {selectedWorkflow && (
                      <dl className="harness-packages-tab__draft-metrics">
                        <div>
                          <dt>Steps</dt>
                          <dd>{selectedWorkflow.steps.length}</dd>
                        </div>
                        <div>
                          <dt>Mode</dt>
                          <dd>{selectedWorkflow.mode}</dd>
                        </div>
                        <div>
                          <dt>Confidence</dt>
                          <dd>{selectedWorkflow.parseConfidence}</dd>
                        </div>
                      </dl>
                    )}

                    {selectedBindingSets.length > 0 && (
                      <ul className="harness-packages-tab__compact-list">
                        {selectedBindingSets.map((set) => (
                          <li key={set.id}>
                            <strong>{set.name}</strong>
                            <span>
                              {set.bindings.length} bindings ·{" "}
                              {formatTimestamp(set.updatedAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {workflowStepRows.length > 0 && (
                      <ul className="harness-packages-tab__step-list">
                        {workflowStepRows.map((step) => (
                          <li key={step.id}>
                            <div className="harness-packages-tab__step-title">
                              <strong>{step.title}</strong>
                              <code>{step.id}</code>
                            </div>
                            <dl>
                              <div>
                                <dt>Owner</dt>
                                <dd>{step.owner}</dd>
                              </div>
                              <div>
                                <dt>Depends</dt>
                                <dd>{step.dependsOn}</dd>
                              </div>
                              <div>
                                <dt>Artifacts</dt>
                                <dd>{step.artifacts}</dd>
                              </div>
                              <div>
                                <dt>Output</dt>
                                <dd>{step.outputContract}</dd>
                              </div>
                            </dl>
                          </li>
                        ))}
                      </ul>
                    )}

                    {repairDraft && (
                      <section
                        className="harness-packages-tab__repair"
                        aria-label="Manual workflow repair"
                      >
                        <div className="harness-packages-tab__repair-header">
                          <strong>Manual repair</strong>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => void handleSaveRepairSnapshot()}
                            disabled={
                              busy ||
                              selectedWorkflow === null ||
                              repairIssues.length > 0
                            }
                          >
                            {busy ? "Saving..." : "Save Snapshot"}
                          </button>
                        </div>

                        <label className="harness-packages-tab__field">
                          <span>Note</span>
                          <input
                            value={repairDraft.note}
                            onChange={(event) =>
                              updateRepairNote(event.currentTarget.value)
                            }
                            placeholder="Review note"
                          />
                        </label>

                        {repairIssues.length > 0 && (
                          <p className="harness-packages-tab__repair-issue">
                            {repairIssues[0]}
                          </p>
                        )}

                        <ul className="harness-packages-tab__repair-list">
                          {repairDraft.steps.map((step) => (
                            <li key={step.stepId}>
                              <div className="harness-packages-tab__step-title">
                                <strong>{step.stepId}</strong>
                              </div>
                              <div className="harness-packages-tab__repair-grid">
                                <label className="harness-packages-tab__repair-control">
                                  <span>Title</span>
                                  <input
                                    value={step.title}
                                    onChange={(event) =>
                                      updateRepairStep(step.stepId, {
                                        title: event.currentTarget.value,
                                      })
                                    }
                                  />
                                </label>
                                <label className="harness-packages-tab__repair-control">
                                  <span>Owner</span>
                                  <input
                                    value={step.agentRef}
                                    onChange={(event) =>
                                      updateRepairStep(step.stepId, {
                                        agentRef: event.currentTarget.value,
                                      })
                                    }
                                    placeholder="agent id"
                                  />
                                </label>
                                <label className="harness-packages-tab__repair-control">
                                  <span>Role</span>
                                  <input
                                    value={step.roleHint}
                                    onChange={(event) =>
                                      updateRepairStep(step.stepId, {
                                        roleHint: event.currentTarget.value,
                                      })
                                    }
                                  />
                                </label>
                                <label className="harness-packages-tab__repair-control">
                                  <span>Depends</span>
                                  <input
                                    value={step.dependsOnText}
                                    onChange={(event) =>
                                      updateRepairStep(step.stepId, {
                                        dependsOnText:
                                          event.currentTarget.value,
                                      })
                                    }
                                    placeholder="step-id, step-id"
                                  />
                                </label>
                                <label className="harness-packages-tab__repair-control">
                                  <span>Artifacts</span>
                                  <input
                                    value={step.artifactsText}
                                    onChange={(event) =>
                                      updateRepairStep(step.stepId, {
                                        artifactsText: event.currentTarget.value,
                                      })
                                    }
                                    placeholder="_workspace/result.md"
                                  />
                                </label>
                                <label className="harness-packages-tab__repair-control">
                                  <span>Output</span>
                                  <select
                                    value={step.outputContract}
                                    onChange={(event) =>
                                      updateRepairStep(step.stepId, {
                                        outputContract: event.currentTarget
                                          .value as HarnessWorkflowStepRepairDraft["outputContract"],
                                      })
                                    }
                                  >
                                    {WORKER_OUTPUT_CONTRACTS.map((contract) => (
                                      <option key={contract} value={contract}>
                                        {contract}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="harness-packages-tab__repair-control harness-packages-tab__repair-control--wide">
                                  <span>Instruction</span>
                                  <textarea
                                    value={step.instruction}
                                    rows={3}
                                    onChange={(event) =>
                                      updateRepairStep(step.stepId, {
                                        instruction: event.currentTarget.value,
                                      })
                                    }
                                  />
                                </label>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                    {profileList.kind === "loading" && (
                      <p>AgentProfile 목록을 불러오는 중...</p>
                    )}
                    {profileList.kind === "error" && (
                      <p>{profileList.message}</p>
                    )}
                    {profileList.kind === "ready" && (
                      <>
                        {bindingCandidates.length === 0 ? (
                          <p>No agent refs in this workflow.</p>
                        ) : (
                          <ul className="harness-packages-tab__binding-list">
                            {bindingCandidates.map((candidate) => {
                              const selectedProfileId =
                                bindings[candidate.harnessAgentRef] ?? "";
                              const isUnbound = selectedProfileId.length === 0;
                              const isCreating =
                                creatingProfileRef ===
                                candidate.harnessAgentRef;
                              return (
                                <li key={candidate.harnessAgentRef}>
                                  <div>
                                    <strong>{candidate.label}</strong>
                                    <span>
                                      {candidate.harnessAgentRef} ·{" "}
                                      {candidate.stepCount} steps
                                    </span>
                                  </div>
                                  <select
                                    value={selectedProfileId}
                                    onChange={(event) =>
                                      handleBindingChange(
                                        candidate.harnessAgentRef,
                                        event.currentTarget.value,
                                      )
                                    }
                                    disabled={creatingProfileRef !== null}
                                  >
                                    <option value="">Unbound</option>
                                    {profileList.profiles.map((profile) => (
                                      <option
                                        key={profile.id}
                                        value={profile.id}
                                      >
                                        {profile.name}
                                      </option>
                                    ))}
                                  </select>
                                  {isUnbound && (
                                    <button
                                      type="button"
                                      className="btn btn--secondary btn--sm"
                                      onClick={() =>
                                        void handleCreateProfileForBinding(
                                          candidate,
                                        )
                                      }
                                      disabled={creatingProfileRef !== null}
                                    >
                                      {isCreating
                                        ? "추가 중..."
                                        : "새 프로필 추가"}
                                    </button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </>
                    )}

                    {bindingReadiness && (
                      <div
                        className={`harness-packages-tab__readiness harness-packages-tab__readiness--${
                          bindingReadiness.errorCount > 0
                            ? "blocked"
                            : bindingReadiness.warningCount > 0
                              ? "warning"
                              : "ok"
                        }`}
                      >
                        <div className="harness-packages-tab__readiness-header">
                          <strong>Binding readiness</strong>
                          <span>
                            {bindingReadiness.errorCount} errors ·{" "}
                            {bindingReadiness.warningCount} warnings ·{" "}
                            {bindingReadiness.infoCount} info
                          </span>
                        </div>
                        {readinessList.kind === "error" && (
                          <p>{readinessList.message}</p>
                        )}
                        {bindingReadiness.issues.length === 0 ? (
                          <p>Ready for pipeline preview.</p>
                        ) : (
                          <ul className="harness-packages-tab__readiness-list">
                            {bindingReadiness.issues.map((issue, index) => (
                              <li
                                key={`${issue.code}-${issue.profileId ?? issue.harnessAgentRef ?? "package"}-${index}`}
                                className={`harness-packages-tab__readiness-item harness-packages-tab__readiness-item--${issue.severity}`}
                              >
                                <span>{issue.severity}</span>
                                <strong>{issue.code}</strong>
                                <p>{issue.message}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    {preview && (
                      <div
                        className={`harness-packages-tab__preview harness-packages-tab__preview--${
                          preview.ok ? "ok" : "blocked"
                        }`}
                      >
                        {preview.ok ? (
                          <p>
                            {preview.pipeline.steps.length} steps ·{" "}
                            {preview.issues.length} issues
                          </p>
                        ) : (
                          <p>{preview.issues.length} blocking issues</p>
                        )}
                        {preview.issues.length > 0 && (
                          <ul className="harness-packages-tab__issues">
                            {preview.issues.map((issue, index) => (
                              <li key={`${issue.code}-${issue.stepId}-${index}`}>
                                <span>{issue.severity}</span>
                                <strong>{issue.code}</strong>
                                <p>{issue.message}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="harness-packages-tab__section">
                <h4>Skills</h4>
                {selectedPackage.skills.length === 0 ? (
                  <p>No skills imported.</p>
                ) : (
                  <ul className="harness-packages-tab__compact-list">
                    {selectedPackage.skills.map((skill) => (
                      <li key={skill.id}>
                        <strong>{skill.name}</strong>
                        <span>{skill.sourceFile}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="harness-packages-tab__section">
                <h4>Agents</h4>
                {selectedPackage.agents.length === 0 ? (
                  <p>No agents imported.</p>
                ) : (
                  <ul className="harness-packages-tab__compact-list">
                    {selectedPackage.agents.map((agent) => (
                      <li key={agent.id}>
                        <strong>{agent.name}</strong>
                        <span>{agent.sourceFile}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
