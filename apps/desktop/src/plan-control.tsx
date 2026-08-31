/**
 * Plan Control view for drafting, reviewing, approving, and dispatching isolated
 * Pi work. Plans stay in the controller window; every model request and approved
 * execution step starts a fresh Pi session in a separate desktop window.
 *
 * Usage:
 * ```tsx
 * <PlanControlView
 *   api={window.piApp}
 *   snapshot={snapshot}
 *   workspaces={rootWorkspaceOptions}
 *   onStateChange={setSnapshot}
 * />
 * ```
 */

import { useEffect, useMemo, useState } from "react";
import type {
  DesktopAppState,
  NewThreadEnvironment,
  SelectedTranscriptRecord,
  WorkspaceRecord,
  WorkspaceSessionTarget,
} from "./desktop-state";
import type { PiDesktopApi } from "./ipc";

export type PlanStepStatus = "draft" | "reviewed" | "approved" | "dispatched";

export interface PlanControlStep {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly acceptanceCriteria: string;
  readonly workflow: string;
  readonly environment: NewThreadEnvironment;
  readonly status: PlanStepStatus;
  readonly review?: string;
  readonly reviewTarget?: WorkspaceSessionTarget;
  readonly dispatchedTarget?: WorkspaceSessionTarget;
}

export interface PlanControlDocument {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly objective: string;
  readonly sharedContract: string;
  readonly plannerProvider: string;
  readonly plannerModelId: string;
  readonly reviewerProvider: string;
  readonly reviewerModelId: string;
  readonly steps: readonly PlanControlStep[];
  readonly updatedAt: string;
  readonly draftTarget?: WorkspaceSessionTarget;
}

interface PlanControlViewProps {
  readonly api: PiDesktopApi;
  readonly snapshot: DesktopAppState;
  readonly workspaces: readonly WorkspaceRecord[];
}

interface ParsedPlanDraft {
  readonly title: string;
  readonly sharedContract: string;
  readonly steps: readonly PlanControlStep[];
}

const PLAN_STORAGE_PREFIX = "pi-gui:plan-control:v1:";
const PLAN_UPDATED_EVENT = "pi-gui:plan-control-updated";

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createEmptyPlan(workspaceId: string, provider = "", modelId = ""): PlanControlDocument {
  return {
    id: createId(),
    workspaceId,
    title: "",
    objective: "",
    sharedContract: "",
    plannerProvider: provider,
    plannerModelId: modelId,
    reviewerProvider: provider,
    reviewerModelId: modelId,
    steps: [],
    updatedAt: new Date().toISOString(),
  };
}

function createEmptyStep(): PlanControlStep {
  return {
    id: createId(),
    title: "",
    scope: "",
    acceptanceCriteria: "",
    workflow: "",
    environment: "worktree",
    status: "draft",
  };
}

function planStorageKey(workspaceId: string): string {
  return `${PLAN_STORAGE_PREFIX}${workspaceId}`;
}

function savePlan(workspaceId: string, plan: PlanControlDocument): void {
  if (!workspaceId) return;
  localStorage.setItem(planStorageKey(workspaceId), JSON.stringify(plan));
  window.dispatchEvent(
    new CustomEvent(PLAN_UPDATED_EVENT, {
      detail: { workspaceId, plan },
    }),
  );
}

function isSessionTarget(value: unknown): value is WorkspaceSessionTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<WorkspaceSessionTarget>;
  return typeof target.workspaceId === "string" && typeof target.sessionId === "string";
}

function parseStoredStep(value: unknown): PlanControlStep | undefined {
  if (!value || typeof value !== "object") return undefined;
  const step = value as Partial<PlanControlStep>;
  if (
    typeof step.id !== "string" ||
    typeof step.title !== "string" ||
    typeof step.scope !== "string" ||
    typeof step.acceptanceCriteria !== "string" ||
    typeof step.workflow !== "string" ||
    (step.environment !== "local" && step.environment !== "worktree") ||
    !["draft", "reviewed", "approved", "dispatched"].includes(step.status ?? "")
  ) {
    return undefined;
  }
  return {
    id: step.id,
    title: step.title,
    scope: step.scope,
    acceptanceCriteria: step.acceptanceCriteria,
    workflow: step.workflow,
    environment: step.environment,
    status: step.status as PlanStepStatus,
    ...(typeof step.review === "string" ? { review: step.review } : {}),
    ...(isSessionTarget(step.reviewTarget) ? { reviewTarget: step.reviewTarget } : {}),
    ...(isSessionTarget(step.dispatchedTarget) ? { dispatchedTarget: step.dispatchedTarget } : {}),
  };
}

function loadPlan(workspaceId: string, provider: string, modelId: string): PlanControlDocument {
  if (!workspaceId) return createEmptyPlan(workspaceId, provider, modelId);
  try {
    const stored = localStorage.getItem(planStorageKey(workspaceId));
    if (!stored) return createEmptyPlan(workspaceId, provider, modelId);
    const value = JSON.parse(stored) as Partial<PlanControlDocument>;
    const steps = Array.isArray(value.steps) ? value.steps.map(parseStoredStep).filter(Boolean) : [];
    if (
      typeof value.id !== "string" ||
      typeof value.title !== "string" ||
      typeof value.objective !== "string" ||
      typeof value.sharedContract !== "string"
    ) {
      return createEmptyPlan(workspaceId, provider, modelId);
    }
    return {
      id: value.id,
      workspaceId,
      title: value.title,
      objective: value.objective,
      sharedContract: value.sharedContract,
      plannerProvider: typeof value.plannerProvider === "string" ? value.plannerProvider : provider,
      plannerModelId: typeof value.plannerModelId === "string" ? value.plannerModelId : modelId,
      reviewerProvider: typeof value.reviewerProvider === "string" ? value.reviewerProvider : provider,
      reviewerModelId: typeof value.reviewerModelId === "string" ? value.reviewerModelId : modelId,
      steps: steps as readonly PlanControlStep[],
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
      ...(isSessionTarget(value.draftTarget) ? { draftTarget: value.draftTarget } : {}),
    };
  } catch {
    return createEmptyPlan(workspaceId, provider, modelId);
  }
}

function stripJsonEnvelope(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  return firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : text.trim();
}

/**
 * Build the exact isolated prompt for an approved execution step.
 *
 * @param plan - Approved shared plan contract.
 * @param step - The single step being dispatched.
 * @returns A prompt containing no sibling step details.
 * @example
 * buildPlanExecutionPrompt(plan, plan.steps[0]);
 */
export function buildPlanExecutionPrompt(plan: PlanControlDocument, step: PlanControlStep): string {
  const task = [
    "Shared approved contract:",
    plan.sharedContract.trim(),
    "",
    "Approved step:",
    `Title: ${step.title.trim()}`,
    `Scope: ${step.scope.trim()}`,
    `Acceptance criteria: ${step.acceptanceCriteria.trim()}`,
    "",
    "Isolation requirements:",
    "- Work only on this approved step.",
    "- Do not infer or request sibling-step transcripts or state.",
    "- Verify the acceptance criteria before reporting completion.",
  ].join("\n");
  const workflow = step.workflow.trim();
  if (!workflow) return task;
  const command = workflow.startsWith("/") ? workflow : `/skill:${workflow.replace(/^skill:/, "")}`;
  return `${command}\n\n${task}`;
}

/**
 * Build a machine-readable plan drafting request for one explicit model.
 *
 * @param plan - Controller inputs including objective and shared contract.
 * @returns A prompt requiring the supported JSON plan shape.
 * @example
 * buildPlanDraftPrompt(createEmptyPlan("workspace", "openai", "gpt-5"));
 */
export function buildPlanDraftPrompt(plan: PlanControlDocument): string {
  return [
    "Create a stepwise implementation plan. Return JSON only.",
    'Schema: {"title":string,"sharedContract":string,"steps":[{"title":string,"scope":string,"acceptanceCriteria":string,"workflow":string,"environment":"local"|"worktree"}]}',
    "Each step must be independently executable and must not require sibling transcript or state.",
    "Use worktree when concurrent code-writing steps could modify the same repository.",
    "",
    `Objective: ${plan.objective.trim()}`,
    `Required shared contract: ${plan.sharedContract.trim()}`,
  ].join("\n");
}

/**
 * Build an isolated review request for one plan step.
 *
 * @param plan - Shared approved contract and objective.
 * @param step - The only step exposed to the reviewer.
 * @returns A reviewer prompt that omits sibling steps.
 * @example
 * buildPlanReviewPrompt(plan, plan.steps[0]);
 */
export function buildPlanReviewPrompt(plan: PlanControlDocument, step: PlanControlStep): string {
  return [
    "Review this one plan step against the shared contract.",
    "Identify missing constraints, unsafe assumptions, and unverifiable acceptance criteria.",
    "Conclude with APPROVE or REVISE and concise actionable comments.",
    "",
    `Shared contract: ${plan.sharedContract.trim()}`,
    `Objective: ${plan.objective.trim()}`,
    `Step title: ${step.title.trim()}`,
    `Step scope: ${step.scope.trim()}`,
    `Acceptance criteria: ${step.acceptanceCriteria.trim()}`,
    `Workflow: ${step.workflow.trim() || "none"}`,
    `Environment: ${step.environment}`,
  ].join("\n");
}

/**
 * Parse a model's JSON draft into editable typed steps.
 *
 * @param text - Assistant response, optionally wrapped in a JSON code fence.
 * @returns A validated draft with fresh local step identities.
 * @throws Error when required plan or step fields are missing.
 * @example
 * parsePlanDraftResponse('{"title":"Plan","sharedContract":"Keep APIs stable","steps":[]}');
 */
export function parsePlanDraftResponse(text: string): ParsedPlanDraft {
  const value = JSON.parse(stripJsonEnvelope(text)) as {
    title?: unknown;
    sharedContract?: unknown;
    steps?: unknown;
  };
  if (typeof value.title !== "string" || typeof value.sharedContract !== "string" || !Array.isArray(value.steps)) {
    throw new Error("The planner response does not match the required plan schema.");
  }
  const steps = value.steps.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Plan step ${index + 1} is not an object.`);
    }
    const step = candidate as Record<string, unknown>;
    if (
      typeof step.title !== "string" ||
      typeof step.scope !== "string" ||
      typeof step.acceptanceCriteria !== "string"
    ) {
      throw new Error(`Plan step ${index + 1} is missing title, scope, or acceptance criteria.`);
    }
    const environment: NewThreadEnvironment = step.environment === "local" ? "local" : "worktree";
    return {
      id: createId(),
      title: step.title,
      scope: step.scope,
      acceptanceCriteria: step.acceptanceCriteria,
      workflow: typeof step.workflow === "string" ? step.workflow : "",
      environment,
      status: "draft" as const,
    };
  });
  if (steps.length === 0) throw new Error("The planner returned no executable steps.");
  return { title: value.title, sharedContract: value.sharedContract, steps };
}

function latestAssistantText(record: SelectedTranscriptRecord | null): string | undefined {
  if (!record) return undefined;
  for (let index = record.transcript.length - 1; index >= 0; index -= 1) {
    const item = record.transcript[index];
    if (item?.kind === "message" && item.role === "assistant") return item.text;
  }
  return undefined;
}

function sessionStatus(state: DesktopAppState, target: WorkspaceSessionTarget | undefined): string | undefined {
  if (!target) return undefined;
  return state.workspaces
    .find((workspace) => workspace.id === target.workspaceId)
    ?.sessions.find((session) => session.id === target.sessionId)?.status;
}

/**
 * Render the Plan Control surface and coordinate isolated Pi windows.
 *
 * @param props - Desktop API, authoritative state, selectable root workspaces,
 * and state updater owned by the app shell.
 * @returns The persisted plan editor and dispatch controls.
 * @example
 * <PlanControlView api={api} snapshot={state} workspaces={roots} />;
 */
export function PlanControlView({ api, snapshot, workspaces }: PlanControlViewProps) {
  const defaultWorkspaceId =
    workspaces.find((workspace) => workspace.id === snapshot.selectedWorkspaceId)?.id ?? workspaces[0]?.id ?? "";
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const runtime = snapshot.runtimeByWorkspace[workspaceId];
  const defaultProvider = runtime?.settings.defaultProvider ?? "";
  const defaultModelId = runtime?.settings.defaultModelId ?? "";
  const [plan, setPlan] = useState<PlanControlDocument>(() =>
    loadPlan(defaultWorkspaceId, defaultProvider, defaultModelId),
  );
  const [busyStepId, setBusyStepId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!workspaceId && defaultWorkspaceId) setWorkspaceId(defaultWorkspaceId);
  }, [defaultWorkspaceId, workspaceId]);

  useEffect(() => {
    const nextRuntime = snapshot.runtimeByWorkspace[workspaceId];
    setPlan(
      loadPlan(
        workspaceId,
        nextRuntime?.settings.defaultProvider ?? "",
        nextRuntime?.settings.defaultModelId ?? "",
      ),
    );
    setError("");
  }, [workspaceId]);

  useEffect(() => {
    const applyStoredPlan = () => {
      setPlan(loadPlan(workspaceId, defaultProvider, defaultModelId));
    };
    const handlePlanUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ readonly workspaceId: string }>).detail;
      if (detail.workspaceId === workspaceId) applyStoredPlan();
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === planStorageKey(workspaceId)) applyStoredPlan();
    };
    window.addEventListener(PLAN_UPDATED_EVENT, handlePlanUpdated);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(PLAN_UPDATED_EVENT, handlePlanUpdated);
      window.removeEventListener("storage", handleStorage);
    };
  }, [defaultModelId, defaultProvider, workspaceId]);

  const workspace = useMemo(
    () => workspaces.find((candidate) => candidate.id === workspaceId),
    [workspaceId, workspaces],
  );

  const commitPlan = (update: (current: PlanControlDocument) => PlanControlDocument) => {
    const current = loadPlan(workspaceId, defaultProvider, defaultModelId);
    const next = update(current);
    savePlan(workspaceId, next);
    setPlan(next);
  };

  const updatePlan = (patch: Partial<PlanControlDocument>) => {
    commitPlan((current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }));
  };

  const updateStep = (stepId: string, patch: Partial<PlanControlStep>, resetReview = false) => {
    commitPlan((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === stepId
          ? {
              ...step,
              ...patch,
              ...(resetReview && step.status !== "dispatched"
                ? { status: "draft" as const, review: undefined, reviewTarget: undefined }
                : {}),
            }
          : step,
      ),
      updatedAt: new Date().toISOString(),
    }));
  };

  useEffect(() => {
    const target = plan.draftTarget;
    if (!target || sessionStatus(snapshot, target) === "running") return;
    let cancelled = false;
    void api.getSessionTranscript(target).then((record) => {
      if (cancelled) return;
      const response = latestAssistantText(record);
      if (!response) {
        if (sessionStatus(snapshot, target) === "failed") {
          setError("The planner session failed before returning a draft.");
          updatePlan({ draftTarget: undefined });
        }
        return;
      }
      try {
        const draft = parsePlanDraftResponse(response);
        commitPlan((current) => ({
          ...current,
          title: draft.title,
          sharedContract: draft.sharedContract || current.sharedContract,
          steps: draft.steps,
          updatedAt: new Date().toISOString(),
          draftTarget: undefined,
        }));
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        updatePlan({ draftTarget: undefined });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, plan.draftTarget, snapshot.revision]);

  useEffect(() => {
    const pendingSteps = plan.steps.filter(
      (step) => step.reviewTarget && sessionStatus(snapshot, step.reviewTarget) !== "running",
    );
    if (pendingSteps.length === 0) return;
    let cancelled = false;
    for (const step of pendingSteps) {
      const target = step.reviewTarget;
      if (!target) continue;
      void api.getSessionTranscript(target).then((record) => {
        if (cancelled) return;
        const response = latestAssistantText(record);
        if (response) {
          updateStep(step.id, { review: response, reviewTarget: undefined, status: "reviewed" });
          setBusyStepId((current) => (current === step.id ? "" : current));
        } else if (sessionStatus(snapshot, target) === "failed") {
          updateStep(step.id, { reviewTarget: undefined });
          setBusyStepId((current) => (current === step.id ? "" : current));
          setError(`Review failed for ${step.title || "the selected step"}.`);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [api, plan.steps, snapshot.revision]);

  const startModelRequest = async (prompt: string, provider: string, modelId: string) => {
    if (!workspaceId) throw new Error("Select a workspace first.");
    if (!provider.trim() || !modelId.trim()) throw new Error("Select an explicit provider and model first.");
    const result = await api.startThreadInNewWindow({
      rootWorkspaceId: workspaceId,
      environment: "local",
      prompt,
      provider: provider.trim(),
      modelId: modelId.trim(),
    });
    return result.target;
  };

  const generateDraft = async () => {
    setError("");
    try {
      const target = await startModelRequest(
        buildPlanDraftPrompt(plan),
        plan.plannerProvider,
        plan.plannerModelId,
      );
      updatePlan({ draftTarget: target });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const requestReview = async (step: PlanControlStep) => {
    setBusyStepId(step.id);
    setError("");
    try {
      const target = await startModelRequest(
        buildPlanReviewPrompt(plan, step),
        plan.reviewerProvider,
        plan.reviewerModelId,
      );
      updateStep(step.id, { reviewTarget: target });
    } catch (cause) {
      setBusyStepId("");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const dispatchStep = async (step: PlanControlStep) => {
    if (step.status !== "approved") return;
    setBusyStepId(step.id);
    setError("");
    updateStep(step.id, { status: "dispatched" });
    try {
      const result = await api.startThreadInNewWindow({
        rootWorkspaceId: workspaceId,
        environment: step.environment,
        prompt: buildPlanExecutionPrompt(plan, step),
      });
      updateStep(step.id, { status: "dispatched", dispatchedTarget: result.target });
    } catch (cause) {
      updateStep(step.id, { status: "approved", dispatchedTarget: undefined });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyStepId("");
    }
  };

  return (
    <section className="plan-control" data-testid="plan-control">
      <header className="plan-control__header">
        <div>
          <div className="plan-control__eyebrow">Control plane</div>
          <h1>Plan Control</h1>
          <p>Review each step, then dispatch it into an isolated Pi window.</p>
        </div>
        <button
          className="button"
          type="button"
          onClick={() => {
            const emptyPlan = createEmptyPlan(workspaceId, defaultProvider, defaultModelId);
            savePlan(workspaceId, emptyPlan);
            setPlan(emptyPlan);
          }}
        >
          Reset plan
        </button>
      </header>

      {error ? <div className="plan-control__error" role="alert">{error}</div> : null}

      <div className="plan-control__panel">
        <label>
          Workspace
          <select data-testid="plan-workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            {workspaces.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
            ))}
          </select>
        </label>
        <label>
          Plan title
          <input data-testid="plan-title" value={plan.title} onChange={(event) => updatePlan({ title: event.target.value })} />
        </label>
        <label className="plan-control__wide">
          Objective
          <textarea data-testid="plan-objective" rows={3} value={plan.objective} onChange={(event) => updatePlan({ objective: event.target.value })} />
        </label>
        <label className="plan-control__wide">
          Shared approved contract
          <textarea data-testid="plan-contract" rows={5} value={plan.sharedContract} onChange={(event) => updatePlan({ sharedContract: event.target.value })} />
        </label>
      </div>

      <div className="plan-control__models">
        <label>Planner provider<input data-testid="planner-provider" value={plan.plannerProvider} onChange={(event) => updatePlan({ plannerProvider: event.target.value })} /></label>
        <label>Planner model<input data-testid="planner-model" value={plan.plannerModelId} onChange={(event) => updatePlan({ plannerModelId: event.target.value })} /></label>
        <button className="button" type="button" disabled={!plan.objective.trim() || Boolean(plan.draftTarget)} onClick={() => void generateDraft()}>
          {plan.draftTarget ? "Planner running…" : "Draft with LLM"}
        </button>
        <label>Reviewer provider<input data-testid="reviewer-provider" value={plan.reviewerProvider} onChange={(event) => updatePlan({ reviewerProvider: event.target.value })} /></label>
        <label>Reviewer model<input data-testid="reviewer-model" value={plan.reviewerModelId} onChange={(event) => updatePlan({ reviewerModelId: event.target.value })} /></label>
      </div>

      <div className="plan-control__steps-header">
        <div>
          <h2>Approved steps</h2>
          <p>{workspace ? `Fresh sessions will start from ${workspace.name}.` : "Select a workspace."}</p>
        </div>
        <button className="button button--primary" data-testid="add-plan-step" type="button" onClick={() => updatePlan({ steps: [...plan.steps, createEmptyStep()] })}>
          Add step
        </button>
      </div>

      <div className="plan-control__steps">
        {plan.steps.map((step, index) => {
          const dispatched = step.status === "dispatched";
          const complete = step.title.trim() && step.scope.trim() && step.acceptanceCriteria.trim();
          return (
            <article className="plan-step" data-testid={`plan-step-${index}`} key={step.id}>
              <div className="plan-step__header">
                <strong>Step {index + 1}</strong>
                <span className={`plan-step__status plan-step__status--${step.status}`}>{step.status}</span>
              </div>
              <label>Title<input data-testid={`step-title-${index}`} disabled={dispatched} value={step.title} onChange={(event) => updateStep(step.id, { title: event.target.value }, true)} /></label>
              <label>Scope<textarea data-testid={`step-scope-${index}`} disabled={dispatched} rows={4} value={step.scope} onChange={(event) => updateStep(step.id, { scope: event.target.value }, true)} /></label>
              <label>Acceptance criteria<textarea data-testid={`step-acceptance-${index}`} disabled={dispatched} rows={3} value={step.acceptanceCriteria} onChange={(event) => updateStep(step.id, { acceptanceCriteria: event.target.value }, true)} /></label>
              <div className="plan-step__row">
                <label>Workflow<input data-testid={`step-workflow-${index}`} disabled={dispatched} placeholder="friction" value={step.workflow} onChange={(event) => updateStep(step.id, { workflow: event.target.value }, true)} /></label>
                <label>Environment<select data-testid={`step-environment-${index}`} disabled={dispatched} value={step.environment} onChange={(event) => updateStep(step.id, { environment: event.target.value as NewThreadEnvironment }, true)}><option value="worktree">Worktree</option><option value="local">Local</option></select></label>
              </div>
              <label>Review notes<textarea data-testid={`step-review-${index}`} disabled={dispatched} rows={3} value={step.review ?? ""} onChange={(event) => updateStep(step.id, { review: event.target.value, status: "reviewed" })} /></label>
              <div className="plan-step__actions">
                <button className="button" type="button" disabled={dispatched || !complete || busyStepId === step.id} onClick={() => void requestReview(step)}>Ask LLM to review</button>
                <button className="button" type="button" disabled={dispatched || !complete} onClick={() => updateStep(step.id, { status: "reviewed" })}>Mark reviewed</button>
                <button className="button" data-testid={`approve-step-${index}`} type="button" disabled={dispatched || !complete} onClick={() => updateStep(step.id, { status: "approved" })}>Approve</button>
                <button className="button button--primary" data-testid={`dispatch-step-${index}`} type="button" disabled={step.status !== "approved" || busyStepId === step.id} onClick={() => void dispatchStep(step)}>{busyStepId === step.id ? "Dispatching…" : dispatched ? "Dispatched" : "Dispatch"}</button>
              </div>
              {step.dispatchedTarget ? <div className="plan-step__target">Session {step.dispatchedTarget.sessionId}</div> : null}
            </article>
          );
        })}
        {plan.steps.length === 0 ? <div className="plan-control__empty">Add a step manually or ask the planner model for a draft.</div> : null}
      </div>
    </section>
  );
}
