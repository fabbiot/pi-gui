import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
  startHangingOpenAiServer,
} from "../helpers/electron-app";

async function selectedSessionRef(window: Parameters<typeof getDesktopState>[0]): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("create_child_thread returns after a slow worker starts, before its turn completes", async () => {
  test.setTimeout(60_000);
  const proofDir = process.env.PI_APP_ORCHESTRATION_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const server = await startHangingOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-start-ack");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false, enabledModels: ["slow-test/slow"] });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "slow-test",
    defaultModel: "slow",
    enabledModels: ["slow-test/slow"],
  }, null, 2)}\n`);
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      "slow-test": {
        baseUrl: server.baseUrl,
        api: "openai-completions",
        apiKey: "unused",
        models: [{ id: "slow" }],
      },
    },
  }, null, 2)}\n`);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const prompt = "Keep this delegated worker running slowly.";
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error("create_child_thread waited for the slow turn to complete")),
        2_000,
      );
    });
    const result = await Promise.race([
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-start-ack",
        sessionRef: parentRef,
        params: { prompt },
      }),
      timeout,
    ]).finally(() => {
      if (deadline) {
        clearTimeout(deadline);
      }
    });

    expect(result.details).toMatchObject({ deliveryStatus: "running", prompt });
    expect(server.requestCount()).toBeGreaterThan(0);
    const child = (await getDesktopState(window)).orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "create-child-start-ack",
    );
    expect(child?.status).toBe("running");
    const childRunningIndicator = window.locator(
      `.session-row[data-session-id="${child?.childSessionId}"] .session-row__status--running`,
    );
    await expect(childRunningIndicator).toBeVisible();
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "orchestration-child-running.png"),
        fullPage: true,
      });
    }
  } finally {
    await harness.close();
    await server.close();
  }
});

test("create_child_thread surfaces deterministic initial-prompt delivery failures", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-tools");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const prompt = "Child must start this delegated task.";

    await expect(runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-child-delivery-failure",
      sessionRef: parentRef,
      params: { prompt },
    })).rejects.toThrow(/API key|authentication|credential/i);

    const state = await getDesktopState(window);
    const matchingChildren = state.orchestrationChildren.filter(
      (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
    );
    expect(matchingChildren).toHaveLength(1);
    expect(matchingChildren[0]?.status).toBe("failed");
    expect(matchingChildren[0]?.latestTranscript).toMatch(/API key|authentication|credential/i);
    expect(matchingChildren[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Initial prompt delivery failed", status: "failed" }),
    ]));

    // Replaying the same tool call must re-surface the failed launch, not treat
    // the already-created session record as proof of success or create a duplicate.
    await expect(runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-child-delivery-failure",
      sessionRef: parentRef,
      params: { prompt },
    })).rejects.toThrow(/API key|authentication|credential/i);
    expect((await getDesktopState(window)).orchestrationChildren.filter(
      (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
    )).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
