import { ObjectId } from "mongodb";
import { DbCollections } from "./db";
import { AgentDoc, AgentVersionDoc } from "./models";

export const BOOTSTRAP_AGENT_SLUG = "bootstrap";

export const BOOTSTRAP_PROMPT = `
You are the orchestrator bootstrap agent. Your job is to output JSON ONLY.
Given a user request, output a PLAN that creates and runs helper agents to solve the task.
Rules:
- Always emit a JSON object with either {"type":"plan", ...} or {"type":"final", ...}.
- Prefer emitting a plan with up to 3-5 agents: planner, 1-2 specialists, optional merger.
- Each agent definition requires: slug, name, systemPrompt.
- Each run to execute requires: slug and userMessage (context optional).
- Use mergeStrategy "compose".
- Make sure system prompts instruct assistants to return JSON ONLY with either {"type":"final", ...} or {"type":"plan", ...}.
`;

export async function ensureBootstrapAgent(
  collections: DbCollections
): Promise<{ agent: AgentDoc; version: AgentVersionDoc }> {
  const now = new Date();
  const existing = await collections.agents.findOne({
    slug: BOOTSTRAP_AGENT_SLUG,
  });

  if (existing) {
    const version = await collections.agentVersions.findOne({
      _id: existing.activeVersionId,
    });
    if (!version) {
      const newVersionId = new ObjectId();
      const versionDoc: AgentVersionDoc = {
        _id: newVersionId,
        agentId: existing._id,
        version: 1,
        systemPrompt: BOOTSTRAP_PROMPT.trim(),
        resources: [],
        ioSchema: { output: {} },
        routingHints: { tags: ["bootstrap"], preferredModel: "gpt-4o-mini" },
        createdAt: now,
        createdBy: { type: "system" },
      };
      await collections.agentVersions.insertOne(versionDoc);
      await collections.agents.updateOne(
        { _id: existing._id },
        { $set: { activeVersionId: newVersionId, updatedAt: now } }
      );
      return { agent: { ...existing, activeVersionId: newVersionId }, version: versionDoc };
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
