import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import { ensureBootstrapAgent } from "./bootstrap";
import { DbCollections, getCollections } from "./db";
import {
  AgentDoc,
  AgentVersionDoc,
  RunDoc,
  SessionDoc,
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

async function handleAgentList(_params: any, { collections }: { collections: DbCollections }) {
  const agents = await collections.agents
    .find({}, { projection: { systemPrompt: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return {
    agents: agents.map((a) => ({
      agentId: a._id.toString(),
      slug: a.slug,
      name: a.name,
      description: a.description,
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
  const { sessionId, userMessage, parentRunId } = params || {};
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
    input: { userMessage },
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
    .find({ sessionId: new ObjectId(sessionId) })
    .project({
      _id: 1,
      parentRunId: 1,
      agentId: 1,
      status: 1,
      startedAt: 1,
      endedAt: 1,
    })
    .sort({ startedAt: -1 })
    .toArray();
  return { runs: runs.map(serializeDoc) };
}

const handlers: Record<string, RpcHandler> = {
  "session.create": handleSessionCreate,
  "agent.list": handleAgentList,
  "agent.get": handleAgentGet,
  "agent.updatePrompt": handleAgentUpdatePrompt,
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
