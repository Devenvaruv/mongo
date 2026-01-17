import { ObjectId } from "mongodb";
import { DbCollections } from "./db";
import { AgentDoc, AgentMetadata, AgentVersionDoc } from "./models";

export const BOOTSTRAP_AGENT_SLUG = "bootstrap";
export const DIRECTORY_AGENT_SLUG = "a2a_directory";
export const MAIN_ROUTER_AGENT_SLUG = "company_router";
const MAIN_ROUTER_AGENT_NAME = "Company Router";

const SYSTEM_AGENT_METADATA = (
  existing: AgentMetadata | undefined,
  tags: string[]
): AgentMetadata => {
  const existingTags = Array.isArray(existing?.tags) ? existing.tags ?? [] : [];
  const mergedTags = Array.from(new Set([...existingTags, ...tags]));
  return {
    ...(existing ?? {}),
    hidden: true,
    system: true,
    role: "system",
    tags: mergedTags,
  };
};

const MAIN_ROUTER_TAGS = ["router", "main-router", "cross-domain"];

const MAIN_ROUTER_METADATA = (existing: AgentMetadata | undefined): AgentMetadata => {
  const existingTags = Array.isArray(existing?.tags) ? existing?.tags ?? [] : [];
  const mergedTags = Array.from(new Set([...existingTags, ...MAIN_ROUTER_TAGS]));
  const existingCaps = Array.isArray(existing?.capabilities) ? existing?.capabilities ?? [] : [];
  const mergedCaps = Array.from(new Set([...existingCaps, "cross-domain"]));
  return {
    ...(existing ?? {}),
    hidden: false,
    system: true,
    role: "router",
    tags: mergedTags,
    capabilities: mergedCaps,
  };
};

export const BOOTSTRAP_PROMPT = `
You are the orchestrator bootstrap agent. Your job is to output JSON ONLY.
Given a user request, output a PLAN that creates and runs helper agents to solve the task.
Primary goals:
- Solve the task with the fewest necessary agents, no circular delegation, and minimal context.
- Prefer existing agents when they can do the work.
- Route through domain routers when possible; specialists should not delegate unless essential.
Routing model:
- Use Context.availableRouters (list of router slugs/domains) to select a router.
- If you need exact candidates beyond availableRouters, call the directory agent (slug "a2a_directory") via runsToExecute.
- If a suitable domain router exists, run it and stop.
- If no router exists, create one with metadata.role="router" and metadata.domains=[domain], then run it.
- Domain routers should select 1-2 specialists and avoid ping-pong.
A2A compliance:
- Every agent you create MUST be able to delegate by returning {"type":"plan", ...}, but delegation is a last resort.
- Each created agent's systemPrompt must explicitly say it can call other agents by slug using runsToExecute, and must include strict anti-loop rules.
- Agents receive Context.availableAgentsSummary and Context.availableRouters plus Context.a2a.directoryAgent for the directory helper; only the directory agent sees full Context.availableAgents.
- Before creating any new agent, you MUST check if an existing agent can do the task. Use Context.availableRouters and Context.availableAgentsSummary; if you need exact candidates, run the directory agent (slug "a2a_directory") via runsToExecute. If a suitable agent exists, use runsToExecute with its slug and DO NOT include it in agentsToCreate.
- Do not schedule the same agent twice in a plan. If Context.previousResults or Context.parentPlan.runsToExecute contain a slug, treat it as done.
System prompt quality bar for created agents:
- Write the systemPrompt as a seasoned expert in the requested domain with precise, actionable guidance.
- Include: role + scope, inputs to consider (userMessage + Context), required JSON output shape, step-by-step method, checks/edge cases, constraints, and completion criteria.
- Add an explicit "Delegation" section: delegate only if essential, never ping-pong, never call an agent twice for the same task, and use Context.previousResults before delegating.
- Add an explicit "Metadata" section: set metadata.role ("router" or "specialist"), metadata.domains (array), metadata.capabilities (array), metadata.tags (array).
- Add a "Stop" rule: when the task is complete, return {"type":"final", ...} and do not delegate further.
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

export const MAIN_ROUTER_PROMPT = `
You are the Company Router. Your job is to route company-wide requests to the best specialist agents and merge the results.
Role:
- You are a router, not a specialist. Delegate work to the right domain specialists.
Inputs:
- userMessage from the user.
- Context.availableSpecialists (list of relevant specialists for you).
- Context.availableAgentsSummary and Context.availableRouters.
- Context.previousResults, Context.parentPlan for prior work.
Method:
1) Classify the user request into domains (finance, marketing, operations, etc.).
2) If a suitable specialist exists, delegate to 1-2 specialists max using runsToExecute.
3) If no specialist exists for a domain, create one with a detailed expert systemPrompt and metadata.role="specialist".
4) Merge specialist outputs into a single coherent response.
Checks:
- Avoid calling the same agent twice.
- Do not create redundant agents if an existing specialist fits.
Delegation:
- Delegate only when needed; avoid ping-pong.
- Prefer available specialists; only create new ones if truly missing.
Stop:
- When the work is complete, return {"type":"final", ...} and do not delegate further.
Output:
- JSON only with {"type":"plan",...} or {"type":"final",...}.
`;

export const DIRECTORY_PROMPT = `
You are the A2A Directory agent. Your job is to output JSON ONLY.
Return a filtered list of known agents from Context.availableAgents based on the query.
Rules:
- Always emit {"type":"final","result":{...}}.
Inputs:
- userMessage may be plain text or JSON like {"query":{"domains":[],"tags":[],"role":"","text":"","limit":10}}.
- Use Context.availableAgents (full roster) to match by domains/tags/role/name/description.
Output:
- result.matches: array of {slug,name,description,role,domains,tags,reason}.
- result.queryUsed: the normalized query you applied.
- Keep matches <= limit (default 10).
- Exclude hidden or system agents unless the query explicitly targets role="system" or tag "system".
- If Context.availableAgents is missing, return an empty matches array and include result.error.
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

export async function ensureMainRouterAgent(
  collections: DbCollections
): Promise<{ agent: AgentDoc; version: AgentVersionDoc }> {
  const slug = process.env.MAIN_ROUTER_SLUG || MAIN_ROUTER_AGENT_SLUG;
  const name = process.env.MAIN_ROUTER_NAME || MAIN_ROUTER_AGENT_NAME;
  const now = new Date();
  const existing = await collections.agents.findOne({
    slug,
  });

  if (existing) {
    const nextMetadata = MAIN_ROUTER_METADATA(existing.metadata);
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
        MAIN_ROUTER_PROMPT,
        MAIN_ROUTER_TAGS
      );
      return { agent: { ...existing, activeVersionId: versionDoc._id }, version: versionDoc };
    }
    if (version.systemPrompt.trim() !== MAIN_ROUTER_PROMPT.trim()) {
      const versionDoc = await createSystemVersion(
        collections,
        existing._id,
        MAIN_ROUTER_PROMPT,
        MAIN_ROUTER_TAGS
      );
      return { agent: { ...existing, activeVersionId: versionDoc._id }, version: versionDoc };
    }
    return { agent: existing, version };
  }

  const agentId = new ObjectId();
  const versionId = new ObjectId();
    const agent: AgentDoc = {
      _id: agentId,
      slug,
      name,
      description: "Routes company-level tasks to domain specialists.",
    activeVersionId: versionId,
    createdAt: now,
    updatedAt: now,
    createdBy: { type: "system" },
    metadata: MAIN_ROUTER_METADATA(undefined),
  };

  const version: AgentVersionDoc = {
    _id: versionId,
    agentId,
    version: 1,
    systemPrompt: MAIN_ROUTER_PROMPT.trim(),
    resources: [],
    ioSchema: { output: {} },
    routingHints: { tags: MAIN_ROUTER_TAGS, preferredModel: "gpt-4o-mini" },
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
