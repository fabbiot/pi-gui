/**
 * Real Electron acceptance coverage for Plan Control. The suite verifies typed
 * model drafts, per-step review, independent application windows, and exact
 * sibling-state isolation.
 *
 * Usage: run `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/plan-control.spec.ts`.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SelectedTranscriptRecord } from "../../src/desktop-state";
import {
  buildPlanDraftPrompt,
  buildPlanExecutionPrompt,
  buildPlanReviewPrompt,
  parsePlanDraftResponse,
  type PlanControlDocument,
} from "../../src/plan-control";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  startHangingOpenAiServer,
  streamAssistantDeltas,
  type PiAppWindow,
} from "../helpers/electron-app";

async function selectedTranscript(window: Page): Promise<SelectedTranscriptRecord | null> {
  return window.evaluate(async () => {
    const app = (window as PiAppWindow).piApp;
    if (!app) throw new Error("piApp IPC bridge is unavailable");
    return app.getSelectedTranscript();
  });
}

async function waitForPiApp(window: Page): Promise<void> {
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => Boolean((window as PiAppWindow).piApp), undefined, { timeout: 15_000 });
}

function userPrompt(record: SelectedTranscriptRecord | null): string {
  return record?.transcript.find((item) => item.kind === "message" && item.role === "user")?.text ?? "";
}

test("builds isolated prompts and imports a typed LLM draft", () => {
  const plan: PlanControlDocument = {
    id: "plan-1",
    workspaceId: "workspace-1",
    title: "Independent implementation",
    objective: "Ship two independent changes",
    sharedContract: "Preserve public APIs and run the owning test lane.",
    plannerProvider: "openai",
    plannerModelId: "gpt-5.2",
    reviewerProvider: "anthropic",
    reviewerModelId: "claude-opus-4-6",
    updatedAt: "2026-08-30T00:00:00.000Z",
    steps: [
      {
        id: "alpha",
        title: "Alpha change",
        scope: "Implement ALPHA-ONLY-7301.",
        acceptanceCriteria: "Alpha test passes.",
        workflow: "friction",
        environment: "worktree",
        status: "approved",
      },
      {
        id: "beta",
        title: "Beta change",
        scope: "Implement BETA-ONLY-9427.",
        acceptanceCriteria: "Beta test passes.",
        workflow: "",
        environment: "local",
        status: "approved",
      },
    ],
  };

  const executionPrompt = buildPlanExecutionPrompt(plan, plan.steps[0]!);
  expect(executionPrompt).toContain("/skill:friction");
  expect(executionPrompt).toContain("ALPHA-ONLY-7301");
  expect(executionPrompt).not.toContain("BETA-ONLY-9427");
  expect(buildPlanDraftPrompt(plan)).toContain("Return JSON only");
  expect(buildPlanReviewPrompt(plan, plan.steps[1]!)).toContain("BETA-ONLY-9427");
  expect(buildPlanReviewPrompt(plan, plan.steps[1]!)).not.toContain("ALPHA-ONLY-7301");

  const imported = parsePlanDraftResponse(`\n\`\`\`json\n{
    "title": "Imported plan",
    "sharedContract": "Keep the integration boundary stable.",
    "steps": [{
      "title": "One exact step",
      "scope": "Change the desktop owner.",
      "acceptanceCriteria": "The real Electron test passes.",
      "workflow": "friction",
      "environment": "worktree"
    }]
  }\n\`\`\``);
  expect(imported.title).toBe("Imported plan");
  expect(imported.steps).toHaveLength(1);
  expect(imported.steps[0]).toMatchObject({
    title: "One exact step",
    environment: "worktree",
    status: "draft",
  });
});

test("imports an explicit model draft and per-step LLM review", async () => {
  const server = await startHangingOpenAiServer();
  const workspacePath = await makeWorkspace("plan-control-model-review");
  const userDataDir = await makeUserDataDir("pi-gui-plan-model-");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["plan-test/planner"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify({
      defaultProvider: "plan-test",
      defaultModel: "planner",
      enabledModels: ["plan-test/planner"],
    }, null, 2)}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        "plan-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "planner" }],
        },
      },
    }, null, 2)}\n`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const controller = await harness.firstWindow();
    await controller.getByRole("button", { name: "Plan Control" }).click();
    await controller.getByTestId("plan-objective").fill("Produce one independently executable step.");
    await controller.getByTestId("plan-contract").fill("MODEL-SHARED-5189: preserve the desktop boundary.");
    await expect(controller.getByTestId("planner-provider")).toHaveValue("plan-test");
    await expect(controller.getByTestId("planner-model")).toHaveValue("planner");

    const plannerWindowPromise = harness.electronApp.waitForEvent("window");
    await controller.getByRole("button", { name: "Draft with LLM" }).click();
    const plannerWindow = await plannerWindowPromise;
    await waitForPiApp(plannerWindow);
    await expect.poll(server.requestCount, { timeout: 15_000 }).toBeGreaterThan(0);
    await streamAssistantDeltas(harness, plannerWindow, [
      JSON.stringify({
        title: "Model-authored plan",
        sharedContract: "MODEL-SHARED-5189: preserve the desktop boundary.",
        steps: [
          {
            title: "Reviewable model step",
            scope: "Implement MODEL-STEP-6113 without sibling context.",
            acceptanceCriteria: "The deterministic Electron assertion passes.",
            workflow: "friction",
            environment: "local",
          },
        ],
      }),
    ]);

    await expect(controller.getByTestId("plan-title")).toHaveValue("Model-authored plan", { timeout: 15_000 });
    await expect(controller.getByTestId("step-scope-0")).toHaveValue(
      "Implement MODEL-STEP-6113 without sibling context.",
    );

    const reviewWindowPromise = harness.electronApp.waitForEvent("window");
    await controller.getByRole("button", { name: "Ask LLM to review" }).click();
    const reviewWindow = await reviewWindowPromise;
    await waitForPiApp(reviewWindow);
    await streamAssistantDeltas(harness, reviewWindow, [
      "APPROVE — scope is isolated and the acceptance criterion is executable.",
    ]);

    await expect(controller.getByTestId("step-review-0")).toHaveValue(
      "APPROVE — scope is isolated and the acceptance criterion is executable.",
      { timeout: 15_000 },
    );
    await expect(controller.getByTestId("plan-step-0").getByText("reviewed", { exact: true })).toBeVisible();
  } finally {
    await harness.close();
    await server.close();
  }
});

test("dispatches approved steps into independent Electron windows without sibling state", async () => {
  const workspacePath = await makeWorkspace("plan-control-dispatch");
  const userDataDir = await makeUserDataDir("pi-gui-plan-control-");
  const harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspacePath] });

  try {
    const controller = await harness.firstWindow();
    await controller.getByRole("button", { name: "Plan Control" }).click();
    await expect(controller.getByTestId("plan-control")).toBeVisible();

    await controller.getByTestId("plan-title").fill("Two isolated deliveries");
    await controller.getByTestId("plan-objective").fill("Dispatch two independent approved steps.");
    await controller.getByTestId("plan-contract").fill("CONTROL-SHARED-7301: preserve APIs and verify the owning lane.");

    await controller.getByTestId("add-plan-step").click();
    await controller.getByTestId("step-title-0").fill("Alpha delivery");
    await controller.getByTestId("step-scope-0").fill("Implement ALPHA-ONLY-7301 and nothing from sibling steps.");
    await controller.getByTestId("step-acceptance-0").fill("Alpha's exact test passes.");
    await controller.getByTestId("step-workflow-0").fill("friction");
    await controller.getByTestId("step-environment-0").selectOption("local");
    await controller.getByTestId("approve-step-0").click();

    await controller.getByTestId("add-plan-step").click();
    await controller.getByTestId("step-title-1").fill("Beta delivery");
    await controller.getByTestId("step-scope-1").fill("Implement BETA-ONLY-9427 and nothing from sibling steps.");
    await controller.getByTestId("step-acceptance-1").fill("Beta's exact test passes.");
    await controller.getByTestId("step-environment-1").selectOption("local");
    await controller.getByTestId("approve-step-1").click();

    const firstWindowPromise = harness.electronApp.waitForEvent("window");
    await controller.getByTestId("dispatch-step-0").click();
    const alphaWindow = await firstWindowPromise;
    await waitForPiApp(alphaWindow);

    const secondWindowPromise = harness.electronApp.waitForEvent("window");
    await controller.getByTestId("dispatch-step-1").click();
    const betaWindow = await secondWindowPromise;
    await waitForPiApp(betaWindow);

    await expect.poll(() => harness.electronApp.windows().length, { timeout: 15_000 }).toBe(3);
    await expect(controller.getByTestId("plan-control")).toBeVisible();
    await expect(controller.getByTestId("plan-step-0").getByText("dispatched", { exact: true })).toBeVisible();
    await expect(controller.getByTestId("plan-step-1").getByText("dispatched", { exact: true })).toBeVisible();

    await expect.poll(async () => userPrompt(await selectedTranscript(alphaWindow)), { timeout: 15_000 })
      .toContain("ALPHA-ONLY-7301");
    await expect.poll(async () => userPrompt(await selectedTranscript(betaWindow)), { timeout: 15_000 })
      .toContain("BETA-ONLY-9427");

    const alphaPrompt = userPrompt(await selectedTranscript(alphaWindow));
    const betaPrompt = userPrompt(await selectedTranscript(betaWindow));
    expect(alphaPrompt).toContain("CONTROL-SHARED-7301");
    expect(alphaPrompt).toContain("/skill:friction");
    expect(alphaPrompt).not.toContain("BETA-ONLY-9427");
    expect(betaPrompt).toContain("CONTROL-SHARED-7301");
    expect(betaPrompt).not.toContain("ALPHA-ONLY-7301");

    const alphaRecord = await selectedTranscript(alphaWindow);
    const betaRecord = await selectedTranscript(betaWindow);
    expect(alphaRecord?.sessionId).not.toBe(betaRecord?.sessionId);
    expect(alphaRecord?.workspaceId).toBe(betaRecord?.workspaceId);
  } finally {
    await harness.close();
  }
});
