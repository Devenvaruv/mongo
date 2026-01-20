import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import {
  BOOTSTRAP_AGENT_SLUG,
  DIRECTORY_AGENT_SLUG,
  ensureBootstrapAgent,
  ensureDirectoryAgent,
} from "./bootstrap";
import { DbCollections, getCollections } from "./db";
import {
  AgentDoc,
  AgentVersionDoc,
  RunDoc,
  SessionDoc,
  WorkflowDoc,
  WorkflowNode,
} from "./models";
import { executeRun } from "./runEngine";

type RpcHandler = (params: any, ctx: { collections: DbCollections }) => Promise<any>;

function serializeId(id: ObjectId | null | undefined): string | null {
  if (!id) return null;
  return id.toString();
}

function serializeDoc<T extends Record<string, any>>(doc: T | null | undefined): any {
  if (!doc) return null;
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v instanceof ObjectId) {
      result[k] = serializeId(v);
    } else if (v instanceof Date) {
      result[k] = v.toISOString();
    } else {
      result[k] = v;
    }
  }
  return result;
}

async function handleSessionCreate(params: any, { collections }: { collections: DbCollections }) {
  const now = new Date();
  const session: SessionDoc = {
    _id: new ObjectId(),
    title: params?.title,
    createdAt: now,
    metadata: {},
  };
  await collections.sessions.insertOne(session);
  return { sessionId: session._id.toString() };
}

async function handleSessionList(params: any, { collections }: { collections: DbCollections }) {
  const requestedLimit = Number(params?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 200)
    : 50;
  const sessions = await collections.sessions
    .find({}, { projection: { _id: 1, title: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return { sessions: sessions.map(serializeDoc) };
}

async function handleAgentList(_params: any, { collections }: { collections: DbCollections }) {
  const includeHidden = _params?.includeHidden === true;
  const filter = includeHidden ? {} : { "metadata.hidden": { $ne: true } };
  const agents = await collections.agents
    .find(filter, { projection: { systemPrompt: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return {
    agents: agents.map((a) => ({
      agentId: a._id.toString(),
      slug: a.slug,
      name: a.name,
      description: a.description,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      createdBy: a.createdBy,
      metadata: a.metadata,
      activeVersionId: a.activeVersionId.toString(),
    })),
  };
}

async function handleAgentGet(params: any, { collections }: { collections: DbCollections }) {
  const { agentId, slug } = params || {};
  let agent: AgentDoc | null = null;
  if (agentId) {
    agent = await collections.agents.findOne({ _id: new ObjectId(agentId) });
  } else if (slug) {
    agent = await collections.agents.findOne({ slug });
  }
  if (!agent && slug === BOOTSTRAP_AGENT_SLUG) {
    const bootstrap = await ensureBootstrapAgent(collections);
    agent = bootstrap.agent;
  }
  if (!agent && slug === DIRECTORY_AGENT_SLUG) {
    const directory = await ensureDirectoryAgent(collections);
    agent = directory.agent;
  }
  if (!agent) {
    throw new Error("Agent not found");
  }
  const activeVersion = await collections.agentVersions.findOne({
    _id: agent.activeVersionId,
  });
  const versions = await collections.agentVersions
    .find({ agentId: agent._id })
    .project({ _id: 1, version: 1, createdAt: 1 })
    .sort({ version: -1 })
    .toArray();
  return {
    agent: serializeDoc(agent),
    activeVersion: serializeDoc(activeVersion),
    versions: versions.map(serializeDoc),
  };
}

async function handleAgentUpdatePrompt(params: any, { collections }: { collections: DbCollections }) {
  const { agentId, newSystemPrompt } = params || {};
  if (!agentId || !newSystemPrompt) {
    throw new Error("agentId and newSystemPrompt are required");
  }
  const agent = await collections.agents.findOne({ _id: new ObjectId(agentId) });
  if (!agent) {
    throw new Error("Agent not found");
  }
  const latest = await collections.agentVersions
    .find({ agentId: agent._id })
    .sort({ version: -1 })
    .limit(1)
    .next();
  const nextVersion = (latest?.version ?? 0) + 1;
  const now = new Date();
  const versionDoc: AgentVersionDoc = {
    _id: new ObjectId(),
    agentId: agent._id,
    version: nextVersion,
    systemPrompt: newSystemPrompt,
    resources: [],
    ioSchema: { output: {} },
    routingHints: latest?.routingHints ?? {},
    createdAt: now,
    createdBy: { type: "user" },
  };
  await collections.agentVersions.insertOne(versionDoc);
  await collections.agents.updateOne(
    { _id: agent._id },
    { $set: { activeVersionId: versionDoc._id, updatedAt: now } }
  );
  return { agentVersionId: versionDoc._id.toString(), version: nextVersion };
}

async function handleAgentVersionGet(params: any, { collections }: { collections: DbCollections }) {
  const { versionId, agentId } = params || {};
  if (!versionId) {
    throw new Error("versionId is required");
  }
  const query: Record<string, any> = { _id: new ObjectId(versionId) };
  if (agentId) {
    query.agentId = new ObjectId(agentId);
  }
  const version = await collections.agentVersions.findOne(query);
  if (!version) {
    throw new Error("Agent version not found");
  }
  return { version: serializeDoc(version) };
}

async function handleAgentSetActiveVersion(
  params: any,
  { collections }: { collections: DbCollections }
) {
  const { agentId, versionId } = params || {};
  if (!agentId || !versionId) {
    throw new Error("agentId and versionId are required");
  }
  const agentObjectId = new ObjectId(agentId);
  const versionObjectId = new ObjectId(versionId);
  const version = await collections.agentVersions.findOne({
    _id: versionObjectId,
    agentId: agentObjectId,
  });
  if (!version) {
    throw new Error("Agent version not found");
  }
  await collections.agents.updateOne(
    { _id: agentObjectId },
    { $set: { activeVersionId: versionObjectId, updatedAt: new Date() } }
  );
  return { activeVersionId: versionObjectId.toString() };
}

async function resolveAgent(params: any, collections: DbCollections) {
  const { agentId, agentSlug } = params || {};
  let agent: AgentDoc | null = null;
  if (agentId) {
    agent = await collections.agents.findOne({ _id: new ObjectId(agentId) });
  } else if (agentSlug) {
    agent = await collections.agents.findOne({ slug: agentSlug });
  }
  if (agent) {
    const version = await collections.agentVersions.findOne({
      _id: agent.activeVersionId,
    });
    if (!version) {
      throw new Error("Active agent version missing");
    }
    return { agent, version };
  }
  const bootstrap = await ensureBootstrapAgent(collections);
  return bootstrap;
}

async function handleRunStart(params: any, { collections }: { collections: DbCollections }) {
  const { sessionId, userMessage, parentRunId, context } = params || {};
  if (!sessionId || !userMessage) {
    throw new Error("sessionId and userMessage are required");
  }
  const session = await collections.sessions.findOne({ _id: new ObjectId(sessionId) });
  if (!session) {
    throw new Error("Session not found");
  }
  const resolved = await resolveAgent(params, collections);
  const now = new Date();
  const runId = new ObjectId();
  let rootRunId: ObjectId | undefined;
  if (parentRunId) {
    const parent = await collections.runs.findOne({ _id: new ObjectId(parentRunId) });
    if (!parent) {
      throw new Error("parentRunId not found");
    }
    rootRunId = parent.rootRunId ?? parent._id;
  } else {
    rootRunId = runId;
  }
  const runDoc: RunDoc = {
    _id: runId,
    sessionId: session._id,
    agentId: resolved.agent._id,
    agentVersionId: resolved.version._id,
    status: "running",
    parentRunId: parentRunId ? new ObjectId(parentRunId) : null,
    rootRunId,
    input: { userMessage, context },
    startedAt: now,
  };
  await collections.runs.insertOne(runDoc);
  await executeRun(runId, collections);
  return { runId: runId.toString() };
}

async function handleRunGet(params: any, { collections }: { collections: DbCollections }) {
  const { runId } = params || {};
  if (!runId) {
    throw new Error("runId is required");
  }
  const run = await collections.runs.findOne({ _id: new ObjectId(runId) });
  if (!run) {
    throw new Error("Run not found");
  }
  return { run: serializeDoc(run) };
}

async function handleRunEvents(params: any, { collections }: { collections: DbCollections }) {
  const { runId, sinceSeq } = params || {};
  if (!runId) {
    throw new Error("runId is required");
  }
  const filter: Record<string, any> = { runId: new ObjectId(runId) };
  if (sinceSeq !== undefined && sinceSeq !== null) {
    filter.seq = { $gt: Number(sinceSeq) };
  }
  const events = await collections.events.find(filter).sort({ seq: 1 }).toArray();
  const lastSeq =
    events.length > 0 ? events[events.length - 1].seq : Number(sinceSeq ?? 0);
  return { events: events.map(serializeDoc), nextSeq: lastSeq + 1 };
}

async function handleRunTree(params: any, { collections }: { collections: DbCollections }) {
  const { sessionId } = params || {};
  if (!sessionId) {
    throw new Error("sessionId is required");
  }
  const runs = await collections.runs
    .aggregate([
      { $match: { sessionId: new ObjectId(sessionId) } },
      { $sort: { startedAt: -1 } },
      {
        $lookup: {
          from: "agents",
          localField: "agentId",
          foreignField: "_id",
          as: "agent",
        },
      },
      { $unwind: { path: "$agent", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          parentRunId: 1,
          agentId: 1,
          status: 1,
          startedAt: 1,
          endedAt: 1,
          agentSlug: "$agent.slug",
          agentName: "$agent.name",
        },
      },
    ])
    .toArray();
  return { runs: runs.map(serializeDoc) };
}

function normalizeNodes(nodes: any[]): WorkflowNode[] {
  return (nodes || []).map((n) => ({
    id: n.id || n.agentSlug || new ObjectId().toString(),
    agentSlug: n.agentSlug,
    label: n.label ?? n.agentSlug,
    includeUserPrompt: !!n.includeUserPrompt,
    parents: Array.isArray(n.parents) ? n.parents : [],
  }));
}

async function handleWorkflowSave(params: any, { collections }: { collections: DbCollections }) {
  const { workflowId, name, description, nodes } = params || {};
  if (!name || !Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("name and nodes[] are required");
  }
  const normalizedNodes = normalizeNodes(nodes);
  const now = new Date();
  if (workflowId) {
    const _id = new ObjectId(workflowId);
    await collections.workflows.updateOne(
      { _id },
      { $set: { name, description, nodes: normalizedNodes, updatedAt: now } },
      { upsert: true }
    );
    return { workflowId };
  }
  const _id = new ObjectId();
  const doc: WorkflowDoc = {
    _id,
    name,
    description,
    nodes: normalizedNodes,
    createdAt: now,
    updatedAt: now,
  };
  await collections.workflows.insertOne(doc);
  return { workflowId: _id.toString() };
}

async function handleWorkflowList(_params: any, { collections }: { collections: DbCollections }) {
  const workflows = await collections.workflows
    .find({}, { projection: { name: 1, description: 1, updatedAt: 1 } })
    .sort({ updatedAt: -1 })
    .toArray();
  return { workflows: workflows.map(serializeDoc) };
}

async function handleWorkflowGet(params: any, { collections }: { collections: DbCollections }) {
  const { workflowId } = params || {};
  if (!workflowId) {
    throw new Error("workflowId is required");
  }
  const wf = await collections.workflows.findOne({ _id: new ObjectId(workflowId) });
  if (!wf) {
    throw new Error("Workflow not found");
  }
  return { workflow: serializeDoc(wf) };
}

async function startRunInternal(
  payload: {
    sessionId: ObjectId;
    agentSlug?: string;
    agentId?: ObjectId;
    userMessage: string;
    parentRunId?: ObjectId;
    context?: Record<string, unknown>;
  },
  collections: DbCollections
): Promise<{ runId: ObjectId; output?: any; status: string }> {
  const params: any = {
    sessionId: payload.sessionId.toString(),
    agentSlug: payload.agentSlug,
    agentId: payload.agentId?.toString(),
    userMessage: payload.userMessage,
    parentRunId: payload.parentRunId?.toString(),
    context: payload.context,
  };
  const result = await handleRunStart(params, { collections });
  const runId = new ObjectId(result.runId);
  const runDoc = await collections.runs.findOne({ _id: runId });
  return { runId, output: runDoc?.output?.result, status: runDoc?.status ?? "unknown" };
}

async function handleWorkflowRun(params: any, { collections }: { collections: DbCollections }) {
  const { workflowId, sessionId, userMessage } = params || {};
  if (!workflowId || !sessionId || !userMessage) {
    throw new Error("workflowId, sessionId, userMessage are required");
  }
  const session = await collections.sessions.findOne({ _id: new ObjectId(sessionId) });
  if (!session) {
    throw new Error("Session not found");
  }
  const wf = await collections.workflows.findOne({ _id: new ObjectId(workflowId) });
  if (!wf) {
    throw new Error("Workflow not found");
  }
  if (!wf.nodes || wf.nodes.length === 0) {
    throw new Error("Workflow has no nodes");
  }
  const nodeMap = new Map<string, WorkflowNode>();
  wf.nodes.forEach((n: WorkflowNode) => nodeMap.set(n.id, n));
  const outputs: Record<string, any> = {};
  const statuses: Record<string, string> = {};
  const results: any[] = [];
  const visited = new Set<string>();

  const topo = [...wf.nodes]; // assume user arranged; no parallelism, just iterate and check parents
  for (const node of topo) {
    const parents = node.parents || [];
    const parentOutputs: Record<string, any> = {};
    let parentsDone = true;
    parents.forEach((pid) => {
      if (!(pid in outputs)) {
        parentsDone = false;
      } else {
        parentOutputs[pid] = outputs[pid];
      }
    });
    if (!parentsDone) {
      throw new Error(`Parent outputs missing for node ${node.id} (${node.agentSlug})`);
    }

    const includeUserPrompt = node.includeUserPrompt ?? false;
    const nodeMessage = includeUserPrompt
      ? userMessage
      : `Continue from previous agent output and produce the next step.`;
    const context = {
      parentOutputs,
      workflowUserMessage: userMessage,
      nodeLabel: node.label ?? node.agentSlug,
    };
    const { runId, output, status } = await startRunInternal(
      {
        sessionId: session._id,
        agentSlug: node.agentSlug,
        userMessage: nodeMessage,
        context,
      },
      collections
    );
    outputs[node.id] = output;
    statuses[node.id] = status;
    visited.add(node.id);
    results.push({
      nodeId: node.id,
      agentSlug: node.agentSlug,
      runId: runId.toString(),
      status,
      output,
    });
  }

  const finalOutput = results.length > 0 ? results[results.length - 1].output : null;
  return { runs: results, finalOutput };
}

const handlers: Record<string, RpcHandler> = {
  "session.create": handleSessionCreate,
  "session.list": handleSessionList,
  "agent.list": handleAgentList,
  "agent.get": handleAgentGet,
  "agent.updatePrompt": handleAgentUpdatePrompt,
  "agent.version.get": handleAgentVersionGet,
  "agent.setActiveVersion": handleAgentSetActiveVersion,
  "workflow.save": handleWorkflowSave,
  "workflow.list": handleWorkflowList,
  "workflow.get": handleWorkflowGet,
  "workflow.run": handleWorkflowRun,
  "run.start": handleRunStart,
  "run.get": handleRunGet,
  "run.events": handleRunEvents,
  "run.tree": handleRunTree,
};

export async function rpcHandler(req: Request, res: Response) {
  const body = req.body;
  if (!body || body.jsonrpc !== "2.0" || !body.method) {
    return res.status(400).json({ error: "Invalid JSON-RPC 2.0 request" });
  }
  const method = body.method as string;
  const params = body.params;
  const id = body.id ?? null;
  const handler = handlers[method];
  if (!handler) {
    return res.status(400).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  }
  try {
    const collections = await getCollections();
    const result = await handler(params, { collections });
    res.json({ jsonrpc: "2.0", id, result });
  } catch (err: any) {
    console.error("RPC error", err);
    res.status(500).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err?.message || "Internal error" },
    });
  }
}
