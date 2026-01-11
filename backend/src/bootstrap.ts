import { ObjectId } from "mongodb";
import { DbCollections } from "./db";
import { AgentDoc, AgentVersionDoc } from "./models";

export const BOOTSTRAP_AGENT_SLUG = "bootstrap";
export const DIRECTORY_AGENT_SLUG = "a2a_directory";

const SYSTEM_AGENT_METADATA = (existing: Record<string, unknown> | undefined, tags: string[]) => {
  const existingTags = Array.isArray(existing?.tags) ? (existing?.tags as string[]) : [];
  const mergedTags = Array.from(new Set([...existingTags, ...tags]));
  return {
    ...(existing ?? {}),
    hidden: true,
    system: true,
    tags: mergedTags,
  };
};

export const BOOTSTRAP_PROMPT = `
You are the orchestrator bootstrap agent. Your job is to output JSON ONLY.
Given a user request, output a PLAN that creates and runs helper agents to solve the task.
A2A compliance:
- Every agent you create MUST be able to delegate to other agents by returning {"type":"plan", ...}.
- Each created agent's systemPrompt must explicitly say it can call other agents by slug using runsToExecute.
- Agents will receive Context.availableAgents (list of known agents) and Context.a2a.directoryAgent for the directory helper.
- Before creating any new agent, you MUST check if an existing agent can do the task. Use Context.availableAgents; if you need a refresh, run the directory agent (slug "a2a_directory") via runsToExecute. If a suitable agent exists, use runsToExecute with its slug and DO NOT include it in agentsToCreate.
Rules:
- Always emit a JSON object with either {"type":"plan", ...} or {"type":"final", ...}.
- For plans, you MUST use the exact fields: "agentsToCreate" (array) and "runsToExecute" (array). Do NOT use "agents" or "runs".
- Prefer emitting a plan with up to 3-5 agents: planner, 1-2 specialists, optional merger.
- Each agent definition requires: slug, name, systemPrompt.
- Each run to execute requires: slug and userMessage (context optional). Order runs so later runs can use outputs from earlier runs.
- Use mergeStrategy "compose".
- Make sure system prompts instruct assistants to return JSON ONLY with either {"type":"final", ...} or {"type":"plan", ...}.
- When referencing existing agents, use runsToExecute with their slug. Do not invent slugs unless you also create them.
`;

export const DIRECTORY_PROMPT = `
You are the A2A Directory agent. Your job is to output JSON ONLY.
Return a list of known agents from Context.availableAgents.
Rules:
- Always emit {"type":"final","result":{...}}.
- Include the raw list under result.agents.
- If Context.availableAgents is missing, return an empty list and include an error string.
`;

async function createSystemVersion(
  collections: DbCollections,
  agentId: ObjectId,
  systemPrompt: string,
  tags: string[]
): Promise<AgentVersionDoc> {
  const latest = await collections.agentVersions
    .find({ agentId })
    .sort({ version: -1 })
    .limit(1)
    .next();
  const nextVersion = (latest?.version ?? 0) + 1;
  const now = new Date();
  const versionDoc: AgentVersionDoc = {
    _id: new ObjectId(),
    agentId,
    version: nextVersion,
    systemPrompt: systemPrompt.trim(),
    resources: [],
    ioSchema: { output: {} },
    routingHints: { tags, preferredModel: "gpt-4o-mini" },
    createdAt: now,
    createdBy: { type: "system" },
  };
  await collections.agentVersions.insertOne(versionDoc);
  await collections.agents.updateOne(
    { _id: agentId },
    { $set: { activeVersionId: versionDoc._id, updatedAt: now } }
  );
  return versionDoc;
}

export async function ensureBootstrapAgent(
  collections: DbCollections
): Promise<{ agent: AgentDoc; version: AgentVersionDoc }> {
  const now = new Date();
  const existing = await collections.agents.findOne({
    slug: BOOTSTRAP_AGENT_SLUG,
  });

  if (existing) {
    const nextMetadata = SYSTEM_AGENT_METADATA(existing.metadata, ["bootstrap", "system"]);
    await collections.agents.updateOne(
      { _id: existing._id },
      { $set: { metadata: nextMetadata, updatedAt: now } }
    );
    const version = await collections.agentVersions.findOne({
      _id: existing.activeVersionId,
    });
    if (!version) {
      const versionDoc = await createSystemVersion(
        collections,
        existing._id,
        BOOTSTRAP_PROMPT,
        ["bootstrap"]
      );
      return { agent: { ...existing, activeVersionId: versionDoc._id }, version: versionDoc };
    }
    if (version.systemPrompt.trim() !== BOOTSTRAP_PROMPT.trim()) {
      const versionDoc = await createSystemVersion(
        collections,
        existing._id,
        BOOTSTRAP_PROMPT,
        ["bootstrap"]
      );
      return { agent: { ...existing, activeVersionId: versionDoc._id }, version: versionDoc };
    }

    return { agent: existing, version };
  }

  const agentId = new ObjectId();
  const versionId = new ObjectId();
  const agent: AgentDoc = {
    _id: agentId,
    slug: BOOTSTRAP_AGENT_SLUG,
    name: "Bootstrap Orchestrator",
    description: "Hardcoded orchestrator that plans and spawns helper agents.",
    activeVersionId: versionId,
    createdAt: now,
    updatedAt: now,
    createdBy: { type: "system" },
    metadata: SYSTEM_AGENT_METADATA(undefined, ["bootstrap", "system"]),
  };

  const version: AgentVersionDoc = {
    _id: versionId,
    agentId,
    version: 1,
    systemPrompt: BOOTSTRAP_PROMPT.trim(),
    resources: [],
    ioSchema: { output: {} },
    routingHints: { tags: ["bootstrap"], preferredModel: "gpt-4o-mini" },
    createdAt: now,
    createdBy: { type: "system" },
  };

  await collections.agents.insertOne(agent);
  await collections.agentVersions.insertOne(version);

  return { agent, version };
}

export async function ensureDirectoryAgent(
  collections: DbCollections
): Promise<{ agent: AgentDoc; version: AgentVersionDoc }> {
  const now = new Date();
  const existing = await collections.agents.findOne({
    slug: DIRECTORY_AGENT_SLUG,
  });

  if (existing) {
    const nextMetadata = SYSTEM_AGENT_METADATA(existing.metadata, ["directory", "system"]);
    await collections.agents.updateOne(
      { _id: existing._id },
      { $set: { metadata: nextMetadata, updatedAt: now } }
    );
    const version = await collections.agentVersions.findOne({
      _id: existing.activeVersionId,
    });
    if (!version) {
      const versionDoc = await createSystemVersion(
        collections,
        existing._id,
        DIRECTORY_PROMPT,
        ["directory"]
      );
      return { agent: { ...existing, activeVersionId: versionDoc._id }, version: versionDoc };
    }
    if (version.systemPrompt.trim() !== DIRECTORY_PROMPT.trim()) {
      const versionDoc = await createSystemVersion(
        collections,
        existing._id,
        DIRECTORY_PROMPT,
        ["directory"]
      );
      return { agent: { ...existing, activeVersionId: versionDoc._id }, version: versionDoc };
    }

    return { agent: existing, version };
  }

  const agentId = new ObjectId();
  const versionId = new ObjectId();
  const agent: AgentDoc = {
    _id: agentId,
    slug: DIRECTORY_AGENT_SLUG,
    name: "A2A Directory",
    description: "Hidden system agent that returns the current agent roster.",
    activeVersionId: versionId,
    createdAt: now,
    updatedAt: now,
    createdBy: { type: "system" },
    metadata: SYSTEM_AGENT_METADATA(undefined, ["directory", "system"]),
  };

  const version: AgentVersionDoc = {
    _id: versionId,
    agentId,
    version: 1,
    systemPrompt: DIRECTORY_PROMPT.trim(),
    resources: [],
    ioSchema: { output: {} },
    routingHints: { tags: ["directory"], preferredModel: "gpt-4o-mini" },
    createdAt: now,
    createdBy: { type: "system" },
  };

  await collections.agents.insertOne(agent);
  await collections.agentVersions.insertOne(version);

  return { agent, version };
}
