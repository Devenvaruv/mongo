import crypto from "crypto";
import { ObjectId } from "mongodb";
import { ensureBootstrapAgent, BOOTSTRAP_AGENT_SLUG } from "./bootstrap";
import { DbCollections } from "./db";
import {
  AgentDoc,
  AgentPlanResponse,
  AgentResponse,
  EventDoc,
  PlanAgentSpec,
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

interface AgentResolution {
  requestedSlug: string;
  agentId: ObjectId;
  agentVersionId: ObjectId;
  slug: string;
  reused: boolean;
  matchedOn: string;
  createdNewAgent?: boolean;
  createdNewVersion?: boolean;
}

async function findSimilarAgent(
  spec: PlanAgentSpec,
  collections: DbCollections
): Promise<{ agent: AgentDoc; matchedOn: string; latestVersionId: ObjectId } | null> {
  // Exact slug match first
  const bySlug = await collections.agents.findOne({ slug: spec.slug });
  if (bySlug) {
    return {
      agent: bySlug,
      matchedOn: "slug",
      latestVersionId: bySlug.activeVersionId,
    };
  }
  // Name match (case-insensitive)
  const byName = await collections.agents.findOne({
    name: { $regex: new RegExp(`^${spec.name}$`, "i") },
  });
  if (byName) {
    return {
      agent: byName,
      matchedOn: "name",
      latestVersionId: byName.activeVersionId,
    };
  }
  // Tag overlap (if provided)
  const tags = spec.routingHints?.tags ?? [];
  if (tags.length > 0) {
    const byTags = await collections.agents.findOne({ "metadata.tags": { $in: tags } });
    if (byTags) {
      return {
        agent: byTags,
        matchedOn: "tags",
        latestVersionId: byTags.activeVersionId,
      };
    }
  }
  return null;
}

async function spawnAgentsFromPlan(
  plan: AgentPlanResponse,
  run: RunDoc,
  collections: DbCollections
): Promise<{ resolutions: Record<string, AgentResolution> }> {
  const resolutions: Record<string, AgentResolution> = {};
  const agentSpecs: PlanAgentSpec[] = plan.agentsToCreate ?? [];
  for (const spec of agentSpecs) {
    if (!spec.slug || !spec.name || !spec.systemPrompt) {
      throw new Error("agentsToCreate entries require slug, name, systemPrompt");
    }
    const now = new Date();
    const metadata = {
      origin: {
        parentRunId: run._id,
        rootRunId: run.rootRunId ?? run._id,
        createdByAgentId: run.agentId ?? null,
        userMessage: run.input.userMessage,
      },
      tags: spec.routingHints?.tags ?? [],
    };

    const similar = await findSimilarAgent(spec, collections);
    if (similar) {
      // If the system prompt is identical to latest, just reuse; otherwise, create a new version for same agent.
      const latestVersion = await collections.agentVersions.findOne({
        _id: similar.agent.activeVersionId,
      });
      if (latestVersion && latestVersion.systemPrompt.trim() === spec.systemPrompt.trim()) {
        resolutions[spec.slug] = {
          requestedSlug: spec.slug,
          slug: similar.agent.slug,
          agentId: similar.agent._id,
          agentVersionId: similar.agent.activeVersionId,
          reused: true,
          matchedOn: similar.matchedOn,
        };
        continue;
      }
      // create new version on the existing agent
      const latest = await collections.agentVersions
        .find({ agentId: similar.agent._id })
        .sort({ version: -1 })
        .limit(1)
        .next();
      const nextVersion = (latest?.version ?? 0) + 1;
      const versionId = new ObjectId();
      await collections.agentVersions.insertOne({
        _id: versionId,
        agentId: similar.agent._id,
        version: nextVersion,
        systemPrompt: spec.systemPrompt,
        resources: spec.resources ?? [],
        ioSchema: spec.ioSchema ?? { output: {} },
        routingHints: spec.routingHints ?? {},
        createdAt: now,
        createdBy: { type: "agent", refId: run.agentId ?? undefined },
      });
      await collections.agents.updateOne(
        { _id: similar.agent._id },
        { $set: { activeVersionId: versionId, updatedAt: now } }
      );
      resolutions[spec.slug] = {
        requestedSlug: spec.slug,
        slug: similar.agent.slug,
        agentId: similar.agent._id,
        agentVersionId: versionId,
        reused: false,
        matchedOn: `${similar.matchedOn}-updated`,
        createdNewVersion: true,
      };
      continue;
    }

    // No similar agent; create new
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
      metadata,
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
    resolutions[spec.slug] = {
      requestedSlug: spec.slug,
      slug: spec.slug,
      agentId,
      agentVersionId: versionId,
      reused: false,
      matchedOn: "new",
      createdNewAgent: true,
    };
  }
  return { resolutions };
}

async function createChildRun(
  parentRun: RunDoc,
  agentSlug: string,
  userMessage: string | undefined,
  collections: DbCollections,
  contextData?: Record<string, unknown>,
  resolutions?: Record<string, AgentResolution>
): Promise<ObjectId> {
  const resolved = resolutions?.[agentSlug];
  let agent: AgentDoc | null = null;
  if (resolved) {
    agent = await collections.agents.findOne({ _id: resolved.agentId });
  } else {
    agent = await collections.agents.findOne({ slug: agentSlug });
  }
  const now = new Date();
  if (!agent) {
    // fallback to bootstrap
    const bootstrap = await ensureBootstrapAgent(collections);
    const runId = new ObjectId();
    const runDoc: RunDoc = {
      _id: runId,
      sessionId: parentRun.sessionId,
      agentId: bootstrap.agent._id,
      agentVersionId: resolved?.agentVersionId ?? bootstrap.version._id,
      status: "running",
      parentRunId: parentRun._id,
      rootRunId: parentRun.rootRunId ?? parentRun._id,
      input: { userMessage: userMessage ?? "", context: contextData },
      startedAt: now,
    };
    await collections.runs.insertOne(runDoc);
    return runId;
  }
  const versionIdToUse = resolved?.agentVersionId ?? agent.activeVersionId;
  const activeVersion = await collections.agentVersions.findOne({
    _id: versionIdToUse,
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
    input: { userMessage: userMessage ?? "", context: contextData },
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
        : "You must respond with JSON only. Prefer {\"type\":\"final\",\"result\":{...}}. Only use {\"type\":\"plan\",...} if you truly need to delegate and you MUST include runsToExecute when you do so.";
    const systemPrompt = `${resolved.systemPrompt}\n${instruction}`.trim();
    const promptHash = buildPromptHash(systemPrompt, run.input.userMessage);

    await emit(emitCtx, "MODEL_REQUEST", {
      model: "gpt-4o-mini",
      promptHash,
    });

    const userContent = run.input.context
      ? `${run.input.userMessage}\n\nContext:\n${JSON.stringify(run.input.context, null, 2)}`
      : run.input.userMessage;

    const response = await callModel({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
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
    // Normalize legacy keys if model replies with "agents" / "runs"
    const agentsToCreate: any[] =
      (parsed as any).agentsToCreate ?? (parsed as any).agents ?? [];
    const runsToExecute: any[] =
      (parsed as any).runsToExecute ?? (parsed as any).runs ?? [];

    if (!Array.isArray(agentsToCreate) && !Array.isArray(runsToExecute)) {
      throw new Error("Plan response missing agentsToCreate/runsToExecute arrays");
    }

    await enforceSpawnCap(run, runsToExecute.length, collections);
    await emit(emitCtx, "SPAWN_AGENT_REQUEST", {
      agentsToCreate: agentsToCreate.map((a: any) => a.slug),
      runsToExecute: runsToExecute.map((r: any) => r.slug),
    });

    const normalizedPlan = { ...parsed, agentsToCreate, runsToExecute } as any;

    const { resolutions } = await spawnAgentsFromPlan(normalizedPlan, run, collections);
    for (const c of Object.values(resolutions)) {
      await emit(emitCtx, "SPAWN_AGENT_CREATED", c as any);
    }

    const childOutputs: Record<string, unknown> = {};
    for (const child of runsToExecute) {
      const contextData: Record<string, unknown> = {
        parentPlan: parsed,
        previousResults: childOutputs,
        explicitContext: child.context ?? null,
      };
      const childRunId = await createChildRun(
        run,
        child.slug,
        child.userMessage,
        collections,
        contextData,
        resolutions
      );
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
          createdAgents: Object.values(resolutions).map((r) => r.slug),
          executedAgents: runsToExecute.map((r: any) => r.slug),
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
