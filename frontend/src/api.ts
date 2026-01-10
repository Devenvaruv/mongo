import axios from "axios";

const BASE_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

async function rpc<T>(method: string, params: any): Promise<T> {
  const resp = await axios.post(
    `${BASE_URL}/rpc`,
    {
      jsonrpc: "2.0",
      id: `${method}-${Date.now()}`,
      method,
      params,
    },
    { headers: { "Content-Type": "application/json" } }
  );
  if (resp.data?.error) {
    throw new Error(resp.data.error.message || "RPC error");
  }
  return resp.data.result as T;
}

export const Api = {
  async createSession(title?: string) {
    return rpc<{ sessionId: string }>("session.create", { title });
  },
  async listSessions(limit?: number) {
    return rpc<{ sessions: any[] }>("session.list", { limit });
  },
  async listAgents() {
    return rpc<{ agents: any[] }>("agent.list", {});
  },
  async getAgent(agentId?: string, slug?: string) {
    return rpc<{ agent: any; activeVersion: any; versions: any[] }>("agent.get", {
      agentId,
      slug,
    });
  },
  async getAgentVersion(versionId: string, agentId?: string) {
    return rpc<{ version: any }>("agent.version.get", { versionId, agentId });
  },
  async updatePrompt(agentId: string, newSystemPrompt: string) {
    return rpc<{ agentVersionId: string; version: number }>("agent.updatePrompt", {
      agentId,
      newSystemPrompt,
      editor: "user",
    });
  },
  async setActiveAgentVersion(agentId: string, versionId: string) {
    return rpc<{ activeVersionId: string }>("agent.setActiveVersion", {
      agentId,
      versionId,
    });
  },
  async getAgentCard(slug: string) {
    const resp = await axios.get(`${BASE_URL}/.well-known/agent-card.json`, {
      params: { slug },
    });
    return resp.data as any;
  },
  async startRun(payload: {
    sessionId: string;
    agentSlug?: string;
    agentId?: string;
    userMessage: string;
    parentRunId?: string;
  }) {
    return rpc<{ runId: string }>("run.start", payload);
  },
  async getRun(runId: string) {
    return rpc<{ run: any }>("run.get", { runId });
  },
  async getRunEvents(runId: string, sinceSeq?: number) {
    return rpc<{ events: any[]; nextSeq: number }>("run.events", { runId, sinceSeq });
  },
  async getRunTree(sessionId: string) {
    return rpc<{ runs: any[] }>("run.tree", { sessionId });
  },
};
