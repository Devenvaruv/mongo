import crypto from "crypto";
import { ObjectId } from "mongodb";
import { ensureBootstrapAgent, BOOTSTRAP_AGENT_SLUG, DIRECTORY_AGENT_SLUG } from "./bootstrap";
import { DbCollections } from "./db";
import {
  AgentDoc,
  AgentMetadata,
  AgentPlanResponse,
  AgentResponse,
  EventDoc,
  PlanAgentSpec,
  RunDoc,
} from "./models";
import { callModel } from "./mockModel";
import {
  AgentSummaryItem,
  RoutingState,
  buildAgentSummaryItem,
  buildRouterIndex,
  buildSpecialistIndex,
  extractDomainsFromTags,
  inferRoleFromTags,
  mergeStringArrays,
  normalizeAgentRole,
  normalizeStringArray,
  readRoutingState,
  summarizeAvailableAgents,
  summarizePreviousResults,
} from "./routingUtils";

const DEFAULT_MODEL = process.env.MODEL_NAME || "gpt-4o";
const ROUTING_POLICY = {
  maxDepth: parsePositiveInt(process.env.A2A_MAX_DEPTH, 2),
  maxChildren: parsePositiveInt(process.env.A2A_MAX_CHILDREN, 3),
};
const ROUTER_INDEX_LIMIT = parsePositiveInt(process.env.A2A_ROUTER_INDEX_LIMIT, 50);
const SPECIALIST_INDEX_LIMIT = parsePositiveInt(process.env.A2A_SPECIALIST_INDEX_LIMIT, 50);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

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

async function listAvailableAgents(collections: DbCollections): Promise<AgentSummaryItem[]> {
  const agents = await collections.agents
    .find({}, { projection: { slug: 1, name: 1, description: 1, metadata: 1 } })
    .sort({ createdAt: 1 })
    .toArray();
  return agents.map((agent) => buildAgentSummaryItem(agent));
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
  const tags = mergeStringArrays(
    normalizeStringArray(spec.routingHints?.tags),
    normalizeStringArray(spec.metadata?.tags)
  );
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
    const card = {
      protocolVersion: "0.3.0",
      name: spec.name,
      description: spec.description ?? spec.name,
      url: spec.resources?.find((r) => r.type === "url")?.ref ?? "",
      preferredTransport: "JSONRPC",
      version: "0.1.0",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [
        {
          id: spec.slug,
          name: spec.name,
          description: spec.description ?? spec.name,
          tags: spec.routingHints?.tags ?? [],
        },
      ],
    };
    const originMetadata = {
      origin: {
        parentRunId: run._id,
        rootRunId: run.rootRunId ?? run._id,
        createdByAgentId: run.agentId ?? null,
        userMessage: run.input.userMessage,
      },
      tags: normalizeStringArray(spec.routingHints?.tags),
      card,
    };
    const specMetadata = spec.metadata ?? {};
    const mergedTags = mergeStringArrays(
      normalizeStringArray(originMetadata.tags),
      normalizeStringArray(specMetadata.tags)
    );
    card.skills[0].tags = mergedTags;
    const mergedMetadata: AgentMetadata = {
      ...specMetadata,
      origin: originMetadata.origin,
      tags: mergedTags,
      card,
    };
    const inferredRole = inferRoleFromTags(mergedTags);
    if (!mergedMetadata.role && inferredRole) {
      mergedMetadata.role = inferredRole;
    }
    const inferredDomains = extractDomainsFromTags(mergedTags);
    if (!normalizeStringArray(mergedMetadata.domains).length && inferredDomains.length) {
      mergedMetadata.domains = inferredDomains;
    }

    const similar = await findSimilarAgent(spec, collections);
    if (similar) {
      // If the system prompt is identical to latest, just reuse; otherwise, create a new version for same agent.
      const latestVersion = await collections.agentVersions.findOne({
        _id: similar.agent.activeVersionId,
      });
      if (latestVersion && latestVersion.systemPrompt.trim() === spec.systemPrompt.trim()) {
        if (mergedTags.length > 0 || (specMetadata && Object.keys(specMetadata).length > 0)) {
          const existingMetadata = similar.agent.metadata ?? {};
          const existingTags = normalizeStringArray(existingMetadata.tags);
          const mergedExistingTags = mergeStringArrays(existingTags, mergedTags);
          const nextMetadata: AgentMetadata = {
            ...existingMetadata,
            ...specMetadata,
            tags: mergedExistingTags,
            card,
          };
          const existingRole =
            normalizeAgentRole(nextMetadata) ?? inferRoleFromTags(mergedExistingTags);
          if (!nextMetadata.role && existingRole) {
            nextMetadata.role = existingRole;
          }
          const existingDomains = normalizeStringArray(nextMetadata.domains);
          if (!existingDomains.length && inferredDomains.length) {
            nextMetadata.domains = inferredDomains;
          }
          await collections.agents.updateOne(
            { _id: similar.agent._id },
            {
              $set: {
                metadata: nextMetadata,
                description: spec.description ?? similar.agent.description ?? spec.name,
                updatedAt: now,
              },
            }
          );
        }
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
      const existingMetadata = similar.agent.metadata ?? {};
      const existingTags = normalizeStringArray(existingMetadata.tags);
      const mergedExistingTags = mergeStringArrays(existingTags, mergedTags);
      const nextMetadata: AgentMetadata = {
        ...existingMetadata,
        ...specMetadata,
        tags: mergedExistingTags,
        card,
      };
      const existingRole = normalizeAgentRole(nextMetadata) ?? inferRoleFromTags(mergedExistingTags);
      if (!nextMetadata.role && existingRole) {
        nextMetadata.role = existingRole;
      }
      const existingDomains = normalizeStringArray(nextMetadata.domains);
      if (!existingDomains.length && inferredDomains.length) {
        nextMetadata.domains = inferredDomains;
      }
      await collections.agents.updateOne(
        { _id: similar.agent._id },
        {
          $set: {
            activeVersionId: versionId,
            updatedAt: now,
            metadata: nextMetadata,
            description: spec.description ?? similar.agent.description ?? spec.name,
          },
        }
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
      description: spec.description ?? spec.name,
      activeVersionId: versionId,
      createdAt: now,
      updatedAt: now,
      createdBy: { type: "agent", refId: run.agentId ?? undefined },
      metadata: mergedMetadata,
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
  const limit = 10;
  if (alreadySpawned + requestedChildren > limit) {
    throw new Error(
      `Spawn cap exceeded (current: ${alreadySpawned}, requested: ${requestedChildren}, limit: ${limit})`
    );
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

    const a2aInstruction = [
      "You are an agent in an A2A (agent-to-agent) system.",
      "All responses must be JSON only with type \"final\" or \"plan\".",
      "You may delegate by returning {\"type\":\"plan\",...} with runsToExecute referencing existing agents by slug.",
      "Delegate only when essential for missing expertise or missing data; do not delegate for work you can do.",
      "If you are a specialist and the request is out of your domain, delegate to a router from Context.availableRouters.",
      "Never delegate to any slug already present in Context.routingState.visitedSlugs or Context.parentPlan.runsToExecute; use those results instead.",
      "Avoid ping-pong: do not re-run the same task through multiple agents. If blocked, return a final response with questions or assumptions instead of delegating.",
      "Only create new agents when necessary and include them in agentsToCreate.",
      "Context.availableAgentsSummary is provided for scale; only the directory agent sees full Context.availableAgents.",
      "Context.availableRouters lists router slugs/domains; routers receive Context.availableSpecialists.",
      "Context.self includes your inferred role/domains/tags; use it to decide if a task is in-scope.",
      "If you need exact candidates beyond those lists, call Context.a2a.directoryAgent.slug.",
      "Respect Context.routingPolicy (maxDepth, maxChildren).",
    ].join("\n");
    const instruction =
      resolved.agent.slug === BOOTSTRAP_AGENT_SLUG
        ? a2aInstruction
        : `${a2aInstruction}\nPrefer {\"type\":\"final\",\"result\":{...}} unless delegation is essential.`;
    const systemPrompt = `${resolved.systemPrompt}\n${instruction}`.trim();
    const promptHash = buildPromptHash(systemPrompt, run.input.userMessage);

    await emit(emitCtx, "MODEL_REQUEST", {
      model: DEFAULT_MODEL,
      promptHash,
    });

    const availableAgents = await listAvailableAgents(collections);
    const availableAgentsSummary = summarizeAvailableAgents(availableAgents);
    const availableRouters = buildRouterIndex(availableAgents, ROUTER_INDEX_LIMIT);
    const baseContext = run.input.context ?? {};
    const routingState = readRoutingState(baseContext);
    const routingStateForModel: RoutingState = {
      visitedSlugs: mergeStringArrays(routingState.visitedSlugs, [resolved.agent.slug]),
      routingDepth: routingState.routingDepth,
    };
    const contextData: Record<string, unknown> = { ...baseContext };
    delete (contextData as any).availableAgents;
    contextData.availableAgentsSummary = availableAgentsSummary;
    contextData.availableRouters = availableRouters;
    contextData.routingPolicy = ROUTING_POLICY;
    contextData.routingState = routingStateForModel;
    contextData.self = buildAgentSummaryItem({
      slug: resolved.agent.slug,
      name: resolved.agent.name,
      description: resolved.agent.description,
      metadata: resolved.agent.metadata ?? undefined,
    });
    contextData.a2a = {
      ...(baseContext as any)?.a2a,
      directoryAgent: {
        slug: DIRECTORY_AGENT_SLUG,
        purpose: "Returns the current agent roster.",
      },
    };
    if (normalizeAgentRole(resolved.agent.metadata) === "router") {
      const agentSummary = buildAgentSummaryItem({
        slug: resolved.agent.slug,
        name: resolved.agent.name,
        description: resolved.agent.description,
        metadata: resolved.agent.metadata ?? undefined,
      });
      const routerCaps = normalizeStringArray(resolved.agent.metadata?.capabilities ?? []);
      const routerTags = normalizeStringArray(resolved.agent.metadata?.tags ?? []);
      const isCrossDomain =
        routerCaps.includes("cross-domain") || routerTags.includes("cross-domain");
      const domainFilter = isCrossDomain ? [] : agentSummary.domains;
      contextData.availableSpecialists = buildSpecialistIndex(
        availableAgents,
        SPECIALIST_INDEX_LIMIT,
        domainFilter
      );
    }
    if (resolved.agent.slug === DIRECTORY_AGENT_SLUG) {
      contextData.availableAgents = availableAgents;
    }
    const userContent = `${run.input.userMessage}\n\nContext:\n${JSON.stringify(
      contextData,
      null,
      2
    )}`;

    const response = await callModel({
      model: DEFAULT_MODEL,
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

    const resolvedSummary = buildAgentSummaryItem({
      slug: resolved.agent.slug,
      name: resolved.agent.name,
      description: resolved.agent.description,
      metadata: resolved.agent.metadata ?? undefined,
    });
    const agentRole = resolvedSummary.role;
    if (agentRole === "specialist") {
      if (agentsToCreate.length > 0) {
        throw new Error("Specialist agents cannot create new agents; return type final instead");
      }
      if (runsToExecute.length > 0) {
        if (runsToExecute.length > 1) {
          throw new Error("Specialist agents may delegate to at most one router");
        }
        const routerSlugs = new Set(
          availableAgents.filter((agent) => agent.role === "router").map((agent) => agent.slug)
        );
        const invalid = runsToExecute.filter((runSpec) => !routerSlugs.has(runSpec.slug));
        if (invalid.length > 0) {
          throw new Error(
            `Specialist agents may only delegate to routers; invalid slugs: ${invalid
              .map((runSpec) => runSpec.slug)
              .join(", ")}`
          );
        }
      }
    }
    if (routingStateForModel.routingDepth >= ROUTING_POLICY.maxDepth && runsToExecute.length > 0) {
      throw new Error(
        `Routing depth exceeded (depth: ${routingStateForModel.routingDepth}, max: ${ROUTING_POLICY.maxDepth})`
      );
    }
    if (runsToExecute.length > ROUTING_POLICY.maxChildren) {
      throw new Error(
        `Too many child runs requested (requested: ${runsToExecute.length}, max: ${ROUTING_POLICY.maxChildren})`
      );
    }
    const visitedSlugs = new Set(routingStateForModel.visitedSlugs);
    const requestedSlugs = new Set<string>();
    for (const runSpec of runsToExecute) {
      const slug = runSpec?.slug;
      if (!slug || typeof slug !== "string") {
        throw new Error("runsToExecute entries require slug");
      }
      if (requestedSlugs.has(slug)) {
        throw new Error(`Duplicate slug in runsToExecute: ${slug}`);
      }
      if (visitedSlugs.has(slug)) {
        throw new Error(`Slug already executed in this run tree: ${slug}`);
      }
      requestedSlugs.add(slug);
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
    const parentPlanSlugs = runsToExecute
      .map((child) => child?.slug)
      .filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
    const visitedForChildren = new Set(routingStateForModel.visitedSlugs);
    for (const child of runsToExecute) {
      const childVisited = new Set([...visitedForChildren, ...parentPlanSlugs]);
      childVisited.add(child.slug);
      const contextData: Record<string, unknown> = {
        parentPlan: parsed,
        previousResults: summarizePreviousResults(childOutputs),
        explicitContext: child.context ?? null,
        routingPolicy: ROUTING_POLICY,
        routingState: {
          visitedSlugs: Array.from(childVisited),
          routingDepth: routingStateForModel.routingDepth + 1,
        },
      };
      const childRunId = await createChildRun(
        run,
        child.slug,
        child.userMessage,
        collections,
        contextData,
        resolutions
      );
      visitedForChildren.add(child.slug);
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
