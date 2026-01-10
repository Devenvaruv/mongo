import crypto from "crypto";
import { ObjectId } from "mongodb";
import { ensureBootstrapAgent, BOOTSTRAP_AGENT_SLUG } from "./bootstrap";
import { DbCollections } from "./db";
import {
  AgentDoc,
  AgentPlanResponse,
  AgentResponse,
  EventDoc,
  RunDoc,
} from "./models";
import { callModel } from "./mockModel";

interface EmitOptions {
  runId: ObjectId;
  collections: DbCollections;
}

async function nextSeq(runId: ObjectId, collections: DbCollections): Promise<number> {
  const last = await collections.events
    .find({ runId })
    .sort({ seq: -1 })
    .limit(1)
    .next();
  return (last?.seq ?? 0) + 1;
}

async function emit(
  { runId, collections }: EmitOptions,
  type: EventDoc["type"],
  payload: Record<string, unknown>
) {
  const seq = await nextSeq(runId, collections);
  await collections.events.insertOne({
    _id: new ObjectId(),
    runId,
    seq,
    ts: new Date(),
    type,
    payload,
  });
  return seq;
}

function buildPromptHash(systemPrompt: string, user: string): string {
  return crypto.createHash("sha256").update(systemPrompt + user).digest("hex").slice(0, 12);
}

async function loadRun(runId: ObjectId, collections: DbCollections): Promise<RunDoc> {
  const run = await collections.runs.findOne({ _id: runId });
  if (!run) {
    throw new Error("Run not found");
  }
  return run;
}

async function resolveAgentVersion(
  run: RunDoc,
  collections: DbCollections
): Promise<{ agent: AgentDoc; versionId: ObjectId; systemPrompt: string }> {
  if (!run.agentId) {
    const bootstrap = await ensureBootstrapAgent(collections);
    return { agent: bootstrap.agent, versionId: bootstrap.version._id, systemPrompt: bootstrap.version.systemPrompt };
  }
  const agent = await collections.agents.findOne({ _id: run.agentId });
  if (!agent) {
    throw new Error("Agent not found for run");
  }
  const version = await collections.agentVersions.findOne({
    _id: run.agentVersionId ?? agent.activeVersionId,
  });
  if (!version) {
    throw new Error("Agent version not found");
  }
  return { agent, versionId: version._id, systemPrompt: version.systemPrompt };
}

async function parseJsonStrict(content: string): Promise<AgentResponse> {
  const trimmed = content.trim();
  const parsed = JSON.parse(trimmed);
  if (!parsed || (parsed.type !== "plan" && parsed.type !== "final")) {
    throw new Error("Model response missing type plan/final");
  }
  return parsed as AgentResponse;
}

async function spawnAgentsFromPlan(
  plan: AgentPlanResponse,
  run: RunDoc,
  collections: DbCollections
) {
  const agentsCreated: Array<{ slug: string; agentId: ObjectId; agentVersionId: ObjectId }> = [];
  const agentSpecs = plan.agentsToCreate ?? [];
  for (const spec of agentSpecs) {
    if (!spec.slug || !spec.name || !spec.systemPrompt) {
      throw new Error("agentsToCreate entries require slug, name, systemPrompt");
    }
    const now = new Date();
    const existing = await collections.agents.findOne({ slug: spec.slug });
    if (existing) {
      const latest = await collections.agentVersions
        .find({ agentId: existing._id })
        .sort({ version: -1 })
        .limit(1)
        .next();
      const nextVersion = (latest?.version ?? 0) + 1;
      const versionId = new ObjectId();
      await collections.agentVersions.insertOne({
        _id: versionId,
        agentId: existing._id,
        version: nextVersion,
        systemPrompt: spec.systemPrompt,
        resources: spec.resources ?? [],
        ioSchema: spec.ioSchema ?? { output: {} },
        routingHints: spec.routingHints ?? {},
        createdAt: now,
        createdBy: { type: "agent", refId: run.agentId ?? undefined },
      });
      await collections.agents.updateOne(
        { _id: existing._id },
        { $set: { activeVersionId: versionId, updatedAt: now } }
      );
      agentsCreated.push({ slug: spec.slug, agentId: existing._id, agentVersionId: versionId });
    } else {
      const agentId = new ObjectId();
      const versionId = new ObjectId();
      const agent: AgentDoc = {
        _id: agentId,
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        activeVersionId: versionId,
        createdAt: now,
        updatedAt: now,
        createdBy: { type: "agent", refId: run.agentId ?? undefined },
      };
      await collections.agents.insertOne(agent);
      await collections.agentVersions.insertOne({
        _id: versionId,
        agentId,
        version: 1,
        systemPrompt: spec.systemPrompt,
        resources: spec.resources ?? [],
        ioSchema: spec.ioSchema ?? { output: {} },
        routingHints: spec.routingHints ?? {},
        createdAt: now,
        createdBy: { type: "agent", refId: run.agentId ?? undefined },
      });
      agentsCreated.push({ slug: spec.slug, agentId, agentVersionId: versionId });
    }
  }
  return agentsCreated;
}

async function createChildRun(
  parentRun: RunDoc,
  agentSlug: string,
  userMessage: string | undefined,
  collections: DbCollections
): Promise<ObjectId> {
  const agent = await collections.agents.findOne({ slug: agentSlug });
  const now = new Date();
  if (!agent) {
    // fallback to bootstrap
    const bootstrap = await ensureBootstrapAgent(collections);
    const runId = new ObjectId();
    const runDoc: RunDoc = {
      _id: runId,
      sessionId: parentRun.sessionId,
      agentId: bootstrap.agent._id,
      agentVersionId: bootstrap.version._id,
      status: "running",
      parentRunId: parentRun._id,
      rootRunId: parentRun.rootRunId ?? parentRun._id,
      input: { userMessage: userMessage ?? "" },
      startedAt: now,
    };
    await collections.runs.insertOne(runDoc);
    return runId;
  }
  const activeVersion = await collections.agentVersions.findOne({
    _id: agent.activeVersionId,
  });
  if (!activeVersion) {
    throw new Error("Child agent active version missing");
  }
  const runId = new ObjectId();
  const runDoc: RunDoc = {
    _id: runId,
    sessionId: parentRun.sessionId,
    agentId: agent._id,
    agentVersionId: activeVersion._id,
    status: "running",
    parentRunId: parentRun._id,
    rootRunId: parentRun.rootRunId ?? parentRun._id,
    input: { userMessage: userMessage ?? "" },
    startedAt: now,
  };
  await collections.runs.insertOne(runDoc);
  return runId;
}

async function enforceSpawnCap(run: RunDoc, requestedChildren: number, collections: DbCollections) {
  const rootId = run.rootRunId ?? run._id;
  const existing = await collections.runs.countDocuments({ rootRunId: rootId });
  const alreadySpawned = Math.max(0, existing - 1); // exclude root run
  if (alreadySpawned + requestedChildren > 5) {
    throw new Error(`Spawn cap exceeded (current: ${alreadySpawned}, requested: ${requestedChildren}, limit: 5)`);
  }
}

export async function executeRun(runId: ObjectId, collections: DbCollections): Promise<void> {
  const run = await loadRun(runId, collections);
  const emitCtx = { runId, collections };
  try {
    await emit(emitCtx, "RUN_STARTED", { agentId: run.agentId?.toString() });
    const resolved = await resolveAgentVersion(run, collections);
    await emit(emitCtx, "PROMPT_LOADED", {
      agentVersionId: resolved.versionId.toString(),
      agentId: resolved.agent._id.toString(),
      slug: resolved.agent.slug,
    });

    const instruction =
      resolved.agent.slug === BOOTSTRAP_AGENT_SLUG
        ? ""
        : "You must respond with JSON only: either {\"type\":\"final\",\"result\":{...}} or {\"type\":\"plan\",...}.";
    const systemPrompt = `${resolved.systemPrompt}\n${instruction}`.trim();
    const promptHash = buildPromptHash(systemPrompt, run.input.userMessage);

    await emit(emitCtx, "MODEL_REQUEST", {
      model: "gpt-4o-mini",
      promptHash,
    });

    const response = await callModel({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: run.input.userMessage },
      ],
      temperature: 0.2,
    });

    const parsed = await parseJsonStrict(response.content);

    await emit(emitCtx, "MODEL_RESPONSE", parsed as any);

    if (parsed.type === "final") {
      await collections.runs.updateOne(
        { _id: runId },
        {
          $set: {
            status: "succeeded",
            output: { result: parsed.result },
            endedAt: new Date(),
          },
        }
      );
      await emit(emitCtx, "RUN_FINISHED", { status: "succeeded" });
      return;
    }

    // plan
    const runsToExecute = parsed.runsToExecute ?? [];
    await enforceSpawnCap(run, runsToExecute.length, collections);
    await emit(emitCtx, "SPAWN_AGENT_REQUEST", {
      agentsToCreate: (parsed.agentsToCreate ?? []).map((a) => a.slug),
      runsToExecute: runsToExecute.map((r) => r.slug),
    });

    const created = await spawnAgentsFromPlan(parsed, run, collections);
    for (const c of created) {
      await emit(emitCtx, "SPAWN_AGENT_CREATED", c);
    }

    const childOutputs: Record<string, unknown> = {};
    for (const child of runsToExecute) {
      const childRunId = await createChildRun(run, child.slug, child.userMessage, collections);
      await emit(emitCtx, "CHILD_RUN_STARTED", { childRunId: childRunId.toString(), slug: child.slug });
      try {
        await executeRun(childRunId, collections);
        const childRun = await collections.runs.findOne({ _id: childRunId });
        childOutputs[child.slug] = childRun?.output?.result ?? null;
        await emit(emitCtx, "CHILD_RUN_FINISHED", {
          childRunId: childRunId.toString(),
          status: childRun?.status,
        });
      } catch (err: any) {
        childOutputs[child.slug] = { error: err?.message || "child failed" };
        await emit(emitCtx, "CHILD_RUN_FINISHED", {
          childRunId: childRunId.toString(),
          status: "failed",
        });
      }
    }

    const mergedResult = {
      type: "final",
      result: {
        childResultsBySlug: childOutputs,
        planSummary: {
          createdAgents: created.map((c) => c.slug),
          executedAgents: runsToExecute.map((r) => r.slug),
        },
      },
    };

    await collections.runs.updateOne(
      { _id: runId },
      {
        $set: {
          status: "succeeded",
          output: { result: mergedResult.result },
          endedAt: new Date(),
        },
      }
    );
    await emit(emitCtx, "RUN_FINISHED", { status: "succeeded" });
  } catch (err: any) {
    const message = err?.message ?? "Run failed";
    const lastSeq = await nextSeq(runId, collections);
    await collections.runs.updateOne(
      { _id: runId },
      {
        $set: {
          status: "failed",
          error: { message, lastEventSeq: lastSeq - 1 },
          endedAt: new Date(),
        },
      }
    );
    await emit(emitCtx, "ERROR", { message });
    await emit(emitCtx, "RUN_FINISHED", { status: "failed" });
  }
}
