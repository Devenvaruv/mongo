import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Api } from "./api";
import "./index.css";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  Connection,
  Edge,
  Node,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";

type AgentOption = { agentId: string; slug: string; name: string };
type SessionState = { id: string; expiresAt: number };
type SessionProps = {
  sessionId: string;
  setSessionId: (id: string) => void;
  endSession: () => void;
};

type Delegation = {
  id: string;
  from: string;
  to: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
};

const SESSION_TTL_MS = 30 * 60 * 1000;

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));
const nodeWidth = 180;
const nodeHeight = 60;

function layoutNodesForFlow(nodes: Node<any>[], edges: Edge[]) {
  dagreGraph.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 100 });
  nodes.forEach((node) => dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight }));
  edges.forEach((edge) => dagreGraph.setEdge(edge.source, edge.target));
  dagre.layout(dagreGraph);
  return nodes.map((node) => {
    const pos = dagreGraph.node(node.id);
    return {
      ...node,
      position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
      targetPosition: "left" as const,
      sourcePosition: "right" as const,
    };
  });
}

const normalizeStatus = (value?: string) => {
  const next = value?.toLowerCase();
  if (next === "running" || next === "succeeded" || next === "failed") {
    return next;
  }
  return "unknown";
};

const formatTimestamp = (value?: string) => {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString();
};

const buildDelegations = (events: any[], fallbackFrom: string): Delegation[] => {
  const calls = new Map<string, Delegation>();
  const from = fallbackFrom || "agent";
  events.forEach((ev) => {
    if (ev.type === "CHILD_RUN_STARTED") {
      const childRunId = ev.payload?.childRunId || `child-${calls.size + 1}`;
      const toSlug = ev.payload?.slug || "unknown";
      calls.set(childRunId, {
        id: childRunId,
        from,
        to: toSlug,
        status: "running",
        startedAt: ev.ts,
      });
    }
    if (ev.type === "CHILD_RUN_FINISHED") {
      const childRunId = ev.payload?.childRunId;
      if (!childRunId) return;
      const existing = calls.get(childRunId);
      calls.set(childRunId, {
        id: childRunId,
        from: existing?.from ?? from,
        to: existing?.to ?? "unknown",
        status: normalizeStatus(ev.payload?.status),
        startedAt: existing?.startedAt,
        finishedAt: ev.ts,
      });
    }
  });
  return Array.from(calls.values());
};

function Home({ sessionId, setSessionId, endSession }: SessionProps) {
  const [agentRequest, setAgentRequest] = useState<string>(
    "Create 2 specialist agents and 1 reviewer agent for a small demo."
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string>("");
  const [runOutput, setRunOutput] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [nextSeq, setNextSeq] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetRunState = () => {
    setRunId(null);
    setRunStatus("");
    setRunOutput(null);
    setEvents([]);
    setNextSeq(0);
    setLoading(false);
    setError(null);
  };

  useEffect(() => {
    resetRunState();
  }, [sessionId]);

  const createSession = async () => {
    const resp = await Api.createSession("Playground");
    setSessionId(resp.sessionId);
    resetRunState();
  };

  const handleEndSession = () => {
    endSession();
    resetRunState();
  };

  const startCreateAgents = async () => {
    if (!sessionId) {
      setError("Create a session first");
      return;
    }
    if (!agentRequest.trim()) {
      setError("Enter a request first");
      return;
    }
    setLoading(true);
    setError(null);
    setRunOutput(null);
    setEvents([]);
    setNextSeq(0);
    try {
      const resp = await Api.startRun({
        sessionId,
        agentSlug: "bootstrap",
        userMessage: agentRequest,
      });
      setRunId(resp.runId);
      setRunStatus("running");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!runId) return;
    const interval = setInterval(async () => {
      try {
        const ev = await Api.getRunEvents(runId, nextSeq);
        if (ev.events.length) {
          setEvents((prev) => [...prev, ...ev.events]);
          setNextSeq(ev.nextSeq);
        }
        const runResp = await Api.getRun(runId);
        setRunStatus(runResp.run.status);
        if (runResp.run.output) {
          setRunOutput(runResp.run.output);
        }
        if (runResp.run.status !== "running") {
          clearInterval(interval);
        }
      } catch (err: any) {
        setError(err.message);
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [runId, nextSeq]);

  const statusLabel = runStatus || "idle";
  const sessionNote = sessionId ? "Auto-clear after 30 min" : null;
  const delegations = useMemo(() => buildDelegations(events, "bootstrap"), [events]);

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Home</h2>
          <p className="card-subtitle">Describe the agents you want to create.</p>
        </div>
        <div className="row">
          <div className="badge">Session: {sessionId || "none"}</div>
          {sessionNote && <div className="badge subtle">{sessionNote}</div>}
        </div>
      </div>

      <div className="grid-2">
        <div className="stack">
          <div className="field">
            <label className="label">Session</label>
            <div className="row">
              <button className="btn" onClick={createSession} disabled={!!sessionId}>
                Create Session
              </button>
              <button className="btn ghost" onClick={handleEndSession} disabled={!sessionId}>
                End Session
              </button>
              <span className="badge subtle">Run: {runId || "none"}</span>
              <span className="status" data-status={statusLabel}>
                Status: {statusLabel}
              </span>
            </div>
          </div>

          <div className="subcard">
            <div className="subheader">Create Agents</div>
            <div className="field">
              <label className="label">Agent Request</label>
              <textarea
                className="textarea"
                rows={6}
                value={agentRequest}
                onChange={(e) => setAgentRequest(e.target.value)}
                placeholder="Describe what agents you want created"
              />
            </div>
            <button
              className="btn primary"
              onClick={startCreateAgents}
              disabled={!sessionId || loading || !agentRequest.trim()}
            >
              {loading ? "Creating..." : "Create agents"}
            </button>
          </div>

          {error && <div className="alert">{error}</div>}
        </div>

        <div className="stack">
          <div className="subcard">
            <div className="subheader">Live Delegations</div>
            <div className="log">
              {delegations.length === 0 ? (
                <div className="muted">No agent-to-agent calls yet.</div>
              ) : (
                delegations.map((call) => (
                  <div key={call.id} className="log-line">
                    <div className="log-meta">
                      <span className="badge subtle">{call.from}</span>
                      <span className="muted">-&gt;</span>
                      <span className="badge subtle">{call.to}</span>
                      <span className="status" data-status={call.status}>
                        {call.status}
                      </span>
                      {call.startedAt && (
                        <span className="muted">{formatTimestamp(call.startedAt)}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="subcard">
            <div className="subheader">Latest Output</div>
            <pre className="code-block">
              {runOutput ? JSON.stringify(runOutput, null, 2) : "Awaiting output..."}
            </pre>
          </div>
          <div className="subcard">
            <div className="subheader">Next Step</div>
            <div className="muted">
              Once agents are created, switch to Playground to run them.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Playground({ sessionId, setSessionId, endSession }: SessionProps) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string>("");
  const [agentMessage, setAgentMessage] = useState<string>("");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [nextSeq, setNextSeq] = useState<number>(0);
  const [runOutput, setRunOutput] = useState<any>(null);
  const [runStatus, setRunStatus] = useState<string>("");
  const [runTarget, setRunTarget] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = async () => {
    const resp = await Api.listAgents();
    const opts: AgentOption[] = resp.agents.map((a) => ({
      agentId: a.agentId,
      slug: a.slug,
      name: a.name,
    }));
    setAgents(opts);
  };

  useEffect(() => {
    loadAgents().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const available = agents.filter((agent) => agent.slug !== "bootstrap");
    if (!available.length) {
      if (selectedAgentSlug) {
        setSelectedAgentSlug("");
      }
      return;
    }
    if (!available.some((agent) => agent.slug === selectedAgentSlug)) {
      setSelectedAgentSlug(available[0].slug);
    }
  }, [agents, selectedAgentSlug]);

  const resetRunState = () => {
    setRunId(null);
    setEvents([]);
    setRunOutput(null);
    setRunStatus("");
    setNextSeq(0);
    setRunTarget("");
    setLoading(false);
    setError(null);
  };

  useEffect(() => {
    resetRunState();
  }, [sessionId]);

  const createSession = async () => {
    const resp = await Api.createSession("Playground");
    setSessionId(resp.sessionId);
    resetRunState();
  };

  const handleEndSession = () => {
    endSession();
    resetRunState();
  };

  const startRunForAgent = async (agentSlug: string, message: string, label: string) => {
    if (!sessionId) {
      setError("Create a session first");
      return;
    }
    if (!message.trim()) {
      setError("Enter a prompt first");
      return;
    }
    setLoading(true);
    setError(null);
    setEvents([]);
    setRunOutput(null);
    setRunTarget(label);
    try {
      const resp = await Api.startRun({
        sessionId,
        agentSlug,
        userMessage: message,
      });
      setRunId(resp.runId);
      setRunStatus("running");
      setNextSeq(0);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const startAgentRun = async () => {
    if (!selectedAgentSlug) {
      setError("Select an agent to run");
      return;
    }
    await startRunForAgent(selectedAgentSlug, agentMessage, selectedAgentSlug);
  };

  useEffect(() => {
    if (!runId) return;
    const interval = setInterval(async () => {
      try {
        const ev = await Api.getRunEvents(runId, nextSeq);
        if (ev.events.length) {
          setEvents((prev) => [...prev, ...ev.events]);
          setNextSeq(ev.nextSeq);
          if (ev.events.some((event: any) => event.type === "SPAWN_AGENT_CREATED")) {
            loadAgents().catch(() => undefined);
          }
        }
        const runResp = await Api.getRun(runId);
        setRunStatus(runResp.run.status);
        if (runResp.run.output) {
          setRunOutput(runResp.run.output);
        }
        if (runResp.run.status !== "running") {
          clearInterval(interval);
          loadAgents().catch(() => undefined);
        }
      } catch (err: any) {
        setError(err.message);
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [runId, nextSeq]);

  const statusLabel = runStatus || "idle";
  const sessionNote = sessionId ? "Auto-clear after 30 min" : null;
  const taskAgents = agents.filter((agent) => agent.slug !== "bootstrap");
  const runTargetAgent = agents.find((agent) => agent.slug === runTarget);
  const runTargetLabel = runTargetAgent
    ? `${runTargetAgent.name} (${runTargetAgent.slug})`
    : runTarget || "none";
  const delegations = useMemo(
    () => buildDelegations(events, runTarget || "agent"),
    [events, runTarget]
  );

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Playground</h2>
          <p className="card-subtitle">Kick off a run and stream events in real time.</p>
        </div>
        <div className="row">
          <div className="badge">Session: {sessionId || "none"}</div>
          {sessionNote && <div className="badge subtle">{sessionNote}</div>}
        </div>
      </div>

      <div className="grid-2">
        <div className="stack">
          <div className="field">
            <label className="label">Session</label>
            <div className="row">
              <button className="btn" onClick={createSession} disabled={!!sessionId}>
                Create Session
              </button>
              <button className="btn ghost" onClick={handleEndSession} disabled={!sessionId}>
                End Session
              </button>
              <span className="badge subtle">Run: {runId || "none"}</span>
              <span className="badge subtle">Agent: {runTargetLabel}</span>
              <span className="status" data-status={statusLabel}>
                Status: {statusLabel}
              </span>
            </div>
          </div>

          <div className="subcard">
            <div className="subheader">Run an Agent</div>
            {taskAgents.length === 0 ? (
              <div className="muted">No agents yet. Create them above.</div>
            ) : (
              <>
                <div className="field">
                  <label className="label">Agent</label>
                  <select
                    className="input"
                    value={selectedAgentSlug}
                    onChange={(e) => setSelectedAgentSlug(e.target.value)}
                  >
                    {taskAgents.map((agent) => (
                      <option key={agent.slug} value={agent.slug}>
                        {agent.name} ({agent.slug})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Message</label>
                  <textarea
                    className="textarea"
                    rows={4}
                    value={agentMessage}
                    onChange={(e) => setAgentMessage(e.target.value)}
                    placeholder="Send a task to the selected agent"
                  />
                </div>
                <button
                  className="btn primary"
                  onClick={startAgentRun}
                  disabled={!sessionId || loading || !selectedAgentSlug || !agentMessage.trim()}
                >
                  {loading && runTarget === selectedAgentSlug ? "Running..." : "Run agent"}
                </button>
              </>
            )}
          </div>

          {error && <div className="alert">{error}</div>}
        </div>

        <div className="stack">
          <div className="subcard">
            <div className="subheader">Live Delegations</div>
            <div className="log">
              {delegations.length === 0 ? (
                <div className="muted">No agent-to-agent calls yet.</div>
              ) : (
                delegations.map((call) => (
                  <div key={call.id} className="log-line">
                    <div className="log-meta">
                      <span className="badge subtle">{call.from}</span>
                      <span className="muted">-&gt;</span>
                      <span className="badge subtle">{call.to}</span>
                      <span className="status" data-status={call.status}>
                        {call.status}
                      </span>
                      {call.startedAt && (
                        <span className="muted">{formatTimestamp(call.startedAt)}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="subcard">
            <div className="subheader">Events</div>
            <div className="log">
              {events.length === 0 ? (
                <div className="muted">No events yet.</div>
              ) : (
                events.map((ev, idx) => (
                  <div key={idx} className="log-line">
                    <div className="log-meta">
                      <code>{ev.seq}</code>
                      <span className="tag">{ev.type}</span>
                      <span className="muted">{ev.ts}</span>
                    </div>
                    <pre>{JSON.stringify(ev.payload, null, 2)}</pre>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="subcard">
            <div className="subheader">Final Output</div>
            <pre className="code-block">
              {runOutput ? JSON.stringify(runOutput, null, 2) : "Awaiting output..."}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function RunInspector() {
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<any[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [events, setEvents] = useState<any[]>([]);
  const [runDetail, setRunDetail] = useState<any | null>(null);

  const loadSessions = async () => {
    setLoadingSessions(true);
    setSessionError(null);
    try {
      const resp = await Api.listSessions(30);
      setSessions(resp.sessions);
    } catch (err: any) {
      setSessionError(err.message);
    } finally {
      setLoadingSessions(false);
    }
  };

  const loadTree = async () => {
    if (!sessionId) return;
    const resp = await Api.getRunTree(sessionId);
    setRuns(resp.runs);
  };

  useEffect(() => {
    void loadSessions();
  }, []);

  const grouped = useMemo(() => {
    const byParent: Record<string, any[]> = {};
    runs.forEach((r) => {
      const key = r.parentRunId ?? "root";
      byParent[key] = byParent[key] || [];
      byParent[key].push(r);
    });
    return byParent;
  }, [runs]);

  const formatSessionLabel = (session: any) => {
    const createdAt = session?.createdAt ? new Date(session.createdAt) : null;
    const createdLabel =
      createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleString() : "unknown";
    const title = session?.title ? `${session.title} | ` : "";
    return `${title}${createdLabel} | ${session._id}`;
  };

  const renderBranch = (parentId: string | null, depth = 0) => {
    const children = grouped[parentId ?? "root"] || [];
    return children.map((r) => (
      <div key={r._id}>
        <div className="tree-item" style={{ marginLeft: depth * 12 }}>
          <button className="link" onClick={() => selectRun(r._id)}>
            <span className="mono">{r._id}</span>
            <span className="muted">
              {" "}
              {r.agentName || r.agentSlug || r.agentId || "agent"}
            </span>
          </button>
          <span className="status" data-status={r.status || "unknown"}>
            {r.status || "unknown"}
          </span>
        </div>
        {renderBranch(r._id, depth + 1)}
      </div>
    ));
  };

  const selectRun = async (runId: string) => {
    setSelectedRunId(runId);
    const runResp = await Api.getRun(runId);
    setRunDetail(runResp.run);
    const ev = await Api.getRunEvents(runId, 0);
    setEvents(ev.events);
  };

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Run Inspector</h2>
          <p className="card-subtitle">Explore run trees and inspect outputs.</p>
        </div>
        <div className="stack">
          <div className="row">
            <select
              className="input input-inline"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            >
              <option value="">Select previous session</option>
              {sessions.map((session) => (
                <option key={session._id} value={session._id}>
                  {formatSessionLabel(session)}
                </option>
              ))}
            </select>
            <button className="btn" onClick={loadSessions} disabled={loadingSessions}>
              {loadingSessions ? "Refreshing..." : "Refresh Sessions"}
            </button>
            {sessionError && <span className="badge subtle">{sessionError}</span>}
          </div>
          <div className="row">
            <input
              className="input input-inline"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="Session ID"
            />
            <button className="btn" onClick={loadTree} disabled={!sessionId}>
              Load Runs
            </button>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="subcard">
          <div className="subheader">Run Tree</div>
          <div className="log">{renderBranch(null)}</div>
        </div>
        <div className="subcard">
          <div className="subheader">Run Detail</div>
          <div className="row">
            <span className="badge subtle">Selected: {selectedRunId || "none"}</span>
          </div>
          <pre className="code-block">
            {runDetail ? JSON.stringify(runDetail, null, 2) : "Select a run"}
          </pre>
          <div className="subheader">Events</div>
          <div className="log">
            {events.length === 0 ? (
              <div className="muted">No events yet.</div>
            ) : (
              events.map((ev, idx) => (
                <div key={idx} className="log-line">
                  <div className="log-meta">
                    <code>{ev.seq}</code>
                    <span className="tag">{ev.type}</span>
                  </div>
                  <pre>{JSON.stringify(ev.payload, null, 2)}</pre>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function AgentManager() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<any | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState(false);
  const [agentCard, setAgentCard] = useState<any | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [cardMissing, setCardMissing] = useState(false);
  const [prompt, setPrompt] = useState<string>("");
  const [agentMeta, setAgentMeta] = useState<any | null>(null);
  const [message, setMessage] = useState<string>("");

  const loadAgents = async () => {
    const resp = await Api.listAgents();
    const opts: AgentOption[] = resp.agents.map((a) => ({
      agentId: a.agentId,
      slug: a.slug,
      name: a.name,
    }));
    setAgents(opts);
  };

  const loadAgentCard = async (slug?: string) => {
    if (!slug) {
      setAgentCard(null);
      return;
    }
    setCardLoading(true);
    setCardError(null);
    setCardMissing(false);
    try {
      const card = await Api.getAgentCard(slug);
      setAgentCard(card);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) {
        setAgentCard(null);
        setCardMissing(true);
      } else {
        const message = err?.response?.data?.error || err?.message || "Failed to load agent card";
        setCardError(message);
        setAgentCard(null);
      }
    } finally {
      setCardLoading(false);
    }
  };

  const loadVersion = async (versionId: string, agentId?: string) => {
    if (!versionId) {
      setSelectedVersion(null);
      return;
    }
    setLoadingVersion(true);
    setVersionError(null);
    try {
      const resp = await Api.getAgentVersion(versionId, agentId);
      setSelectedVersion(resp.version);
    } catch (err: any) {
      setVersionError(err.message);
      setSelectedVersion(null);
    } finally {
      setLoadingVersion(false);
    }
  };

  const formatDate = (value?: string) => {
    if (!value) return "unknown";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "unknown";
    return parsed.toLocaleString();
  };

  useEffect(() => {
    loadAgents().catch((err) => setMessage(err.message));
  }, []);

  useEffect(() => {
    if (!selectedAgentId && agents.length) {
      void selectAgent(agents[0].agentId);
    }
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (!selectedVersionId) {
      setSelectedVersion(null);
      return;
    }
    void loadVersion(selectedVersionId, agentMeta?.agent?._id);
  }, [selectedVersionId, agentMeta?.agent?._id]);

  useEffect(() => {
    if (!agentMeta?.agent?.slug) return;
    void loadAgentCard(agentMeta.agent.slug);
  }, [agentMeta?.agent?.slug]);

  const selectAgent = async (id: string, preserveMessage = false) => {
    setSelectedAgentId(id);
    if (!preserveMessage) {
      setMessage("");
    }
    setSelectedVersionId("");
    setSelectedVersion(null);
    setVersionError(null);
    setAgentCard(null);
    setCardError(null);
    setCardMissing(false);
    if (!id) {
      setAgentMeta(null);
      setPrompt("");
      return;
    }
    try {
      const resp = await Api.getAgent(id, undefined);
      setAgentMeta(resp);
      setPrompt(resp.activeVersion?.systemPrompt || "");
      const activeId = resp.agent?.activeVersionId ?? resp.activeVersion?._id;
      const nextVersionId = activeId || resp.versions?.[0]?._id || "";
      setSelectedVersionId(nextVersionId);
    } catch (err: any) {
      setMessage(err.message);
      setAgentMeta(null);
      setPrompt("");
    }
  };

  const savePrompt = async () => {
    if (!selectedAgentId) return;
    try {
      await Api.updatePrompt(selectedAgentId, prompt);
      setMessage("Saved new version");
      await selectAgent(selectedAgentId, true);
    } catch (err: any) {
      setMessage(err.message);
    }
  };

  const setDefaultVersion = async () => {
    if (!selectedAgentId || !selectedVersionId) return;
    setSettingDefault(true);
    setMessage("");
    try {
      await Api.setActiveAgentVersion(selectedAgentId, selectedVersionId);
      setMessage("Default version updated");
      await selectAgent(selectedAgentId, true);
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setSettingDefault(false);
    }
  };

  const activeVersionId = agentMeta?.agent?.activeVersionId ?? agentMeta?.activeVersion?._id;
  const activeVersionNumber = agentMeta?.versions?.find(
    (version: any) => version._id === activeVersionId
  )?.version;
  const isSelectedActive = !!selectedVersionId && selectedVersionId === activeVersionId;
  const formatVersionLabel = (version: any) => {
    const versionNumber = version?.version ?? "?";
    const createdAt = formatDate(version?.createdAt);
    const activeLabel = version?._id === activeVersionId ? " (active)" : "";
    return `v${versionNumber}${activeLabel} | ${createdAt}`;
  };

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Agent Manager</h2>
          <p className="card-subtitle">Edit system prompts and track versions.</p>
        </div>
        <div className="row">
          {message && <span className="badge subtle">{message}</span>}
          <button className="btn" onClick={loadAgents}>
            Refresh
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="stack">
          <div className="field">
            <label className="label">Agent</label>
            <select
              className="input"
              value={selectedAgentId}
              onChange={(e) => selectAgent(e.target.value)}
            >
              <option value="">Select agent</option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.name} ({a.slug})
                </option>
              ))}
            </select>
          </div>

          {agentMeta && (
            <>
              <div className="field">
                <label className="label">Version</label>
                <select
                  className="input"
                  value={selectedVersionId}
                  onChange={(e) => setSelectedVersionId(e.target.value)}
                >
                  <option value="">Select version</option>
                  {agentMeta.versions.map((version: any) => (
                    <option key={version._id} value={version._id}>
                      {formatVersionLabel(version)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row">
                <button
                  className="btn ghost"
                  onClick={setDefaultVersion}
                  disabled={!selectedVersionId || isSelectedActive || settingDefault}
                >
                  {settingDefault ? "Setting..." : "Use as default"}
                </button>
                {activeVersionNumber !== undefined && activeVersionNumber !== null && (
                  <span className="badge subtle">Active: v{activeVersionNumber}</span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="stack">
          {!agentMeta ? (
            <div className="empty">Select an agent to view versions and edit prompts.</div>
          ) : (
            <>
              <div className="subcard">
                <div className="subheader">Agent Card</div>
                {cardLoading ? (
                  <div className="muted">Loading agent card...</div>
                ) : cardError ? (
                  <div className="alert">{cardError}</div>
                ) : cardMissing ? (
                  <div className="muted">No agent card found for this agent.</div>
                ) : agentCard ? (
                  <pre className="code-block">{JSON.stringify(agentCard, null, 2)}</pre>
                ) : (
                  <div className="muted">Select an agent to load its card.</div>
                )}
              </div>
              <div className="subcard">
                <div className="subheader">Selected Version</div>
                <div className="stack">
                  {loadingVersion ? (
                    <div className="muted">Loading version...</div>
                  ) : versionError ? (
                    <div className="alert">{versionError}</div>
                  ) : !selectedVersion ? (
                    <div className="muted">Select a version to view details.</div>
                  ) : (
                    <>
                      <div className="row">
                        <span className="badge subtle">v{selectedVersion.version ?? "-"}</span>
                        <span className="badge subtle">{formatDate(selectedVersion.createdAt)}</span>
                        {selectedVersion.createdBy?.type && (
                          <span className="badge subtle">By {selectedVersion.createdBy.type}</span>
                        )}
                        {isSelectedActive && <span className="badge">Default</span>}
                      </div>
                      <div className="field">
                        <label className="label">System Prompt</label>
                        <pre className="code-block">
                          {selectedVersion.systemPrompt || "No prompt"}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="subcard">
                <div className="subheader">New Version</div>
                <div className="muted">Saving creates a new version and sets it as default.</div>
                <div className="field">
                  <label className="label">System Prompt</label>
                  <textarea
                    className="textarea"
                    rows={10}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </div>
                <button className="btn primary" onClick={savePrompt} disabled={!prompt}>
                  Save new version
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

type WorkflowNode = { id: string; agentSlug: string; label: string; includeUserPrompt: boolean };
type WorkflowEdge = { from: string; to: string };
type RFNodeData = { label: string; agentSlug: string; includeUserPrompt: boolean };

function WorkflowBuilder({ sessionId, setSessionId, endSession }: SessionProps) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [wfNodes, setWfNodes] = useState<WorkflowNode[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [workflowName, setWorkflowName] = useState<string>("");
  const [workflowDescription, setWorkflowDescription] = useState<string>("");
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [userMessage, setUserMessage] = useState<string>("Run my chain with this prompt");
  const [runResults, setRunResults] = useState<any[]>([]);
  const [finalOutput, setFinalOutput] = useState<any>(null);
  const [modalContent, setModalContent] = useState<any | null>(null);
  const [modalTitle, setModalTitle] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const loadAgents = async () => {
    const resp = await Api.listAgents();
    const opts: AgentOption[] = resp.agents
      .filter((a) => a.slug !== "bootstrap")
      .map((a) => ({ agentId: a.agentId, slug: a.slug, name: a.name }));
    setAgents(opts);
  };

  const loadWorkflows = async () => {
    const resp = await Api.listWorkflows();
    setWorkflows(resp.workflows);
  };

  useEffect(() => {
    loadAgents().catch((err) => setError(err.message));
    loadWorkflows().catch((err) => setError(err.message));
  }, []);

  const handleDragStart = (slug: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", slug);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const slug = e.dataTransfer.getData("text/plain");
    if (!slug) return;
    addNode(slug, { x: 40, y: 40 + nodes.length * 60 });
  };

  const addNode = (slug: string, position?: { x: number; y: number }) => {
    const agent = agents.find((a) => a.slug === slug);
    if (!agent) return;
    const id = `${slug}-${Date.now()}`;
    const newWfNode = { id, agentSlug: slug, label: agent.name, includeUserPrompt: false };
    setWfNodes((prev) => [...prev, newWfNode]);
    const rfNode: Node<RFNodeData> = {
      id,
      type: "default",
      position: position || { x: 0, y: 0 },
      data: { label: agent.name, agentSlug: slug, includeUserPrompt: false },
    };
    setNodes((nds) => nds.concat(rfNode));
  };

  const removeNode = (id: string) => {
    setWfNodes((prev) => prev.filter((n) => n.id !== id));

    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
  };

  const toggleIncludePrompt = (id: string) => {
    setWfNodes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, includeUserPrompt: !n.includeUserPrompt } : n))
    );
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, includeUserPrompt: !n.data.includeUserPrompt } } : n
      )
    );
  };

  const saveWorkflow = async () => {
    if (!workflowName.trim() || nodes.length === 0) {
      setError("Name and at least one node are required");
      return;
    }
    setError("");
    setMessage("");
    const payload = {
      workflowId: selectedWorkflowId || undefined,
      name: workflowName,
      description: workflowDescription,
      nodes: wfNodes.map((n) => {
        const parents = edges.filter((e: any) => e.target === n.id).map((e: any) => e.source);
        return {
          id: n.id,
          agentSlug: n.agentSlug,
          label: n.label,
          includeUserPrompt: n.includeUserPrompt,
          parents,
        };
      }),
    };
    try {
      const resp = await Api.saveWorkflow(payload);
      setSelectedWorkflowId(resp.workflowId);
      setMessage("Workflow saved");
      await loadWorkflows();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const loadWorkflow = async (workflowId: string) => {
    if (!workflowId) return;
    try {
      const resp = await Api.getWorkflow(workflowId);
      const wf = resp.workflow;
      setSelectedWorkflowId(workflowId);
      setWorkflowName(wf.name || "");
      setWorkflowDescription(wf.description || "");
      const newWfNodes: WorkflowNode[] = (wf.nodes || []).map((n: any) => ({
        id: n.id,
        agentSlug: n.agentSlug,
        label: n.label ?? n.agentSlug,
        includeUserPrompt: !!n.includeUserPrompt,
      }));
      const newEdges: WorkflowEdge[] = [];
      (wf.nodes || []).forEach((n: any) => {
        (n.parents || []).forEach((p: string) => newEdges.push({ from: p, to: n.id }));
      });
      setWfNodes(newWfNodes);
      const rfEdges: Edge[] = newEdges.map((e) => ({
        id: `${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
      }));
      const rfNodes: Node<RFNodeData>[] = newWfNodes.map((n) => ({
        id: n.id,
        type: "default",
        position: { x: 0, y: 0 },
        data: { label: n.label, agentSlug: n.agentSlug, includeUserPrompt: n.includeUserPrompt },
      }));
      setNodes(layoutNodesForFlow(rfNodes, rfEdges));
      setEdges(rfEdges);
      setMessage("Workflow loaded");
    } catch (err: any) {
      setError(err.message);
    }
  };

  const ensureSession = async () => {
    if (sessionId) return sessionId;
    const resp = await Api.createSession("Workflow");
    setSessionId(resp.sessionId);
    return resp.sessionId;
  };

  const runWorkflow = async () => {
    if (!selectedWorkflowId) {
      setError("Save or select a workflow first");
      return;
    }
    const sid = await ensureSession();
    if (!sid) return;
    setLoading(true);
    setError("");
    setMessage("");
    setRunResults([]);
    setFinalOutput(null);
    setModalContent(null);
    setModalTitle("");
    try {
      const resp = await Api.runWorkflow({
        workflowId: selectedWorkflowId,
        sessionId: sid,
        userMessage,
      });
      setRunResults(resp.runs || []);
      setFinalOutput(resp.finalOutput ?? null);
      setMessage("Workflow executed");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const allSucceeded = runResults.length > 0 && runResults.every((r) => r.status === "succeeded");

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Workflow Builder</h2>
          <p className="card-subtitle">Drag agents to build a chain and run it sequentially.</p>
        </div>
        <div className="row">
          <div className="badge">Session: {sessionId || "none"}</div>
          <button className="btn ghost" onClick={endSession} disabled={!sessionId}>
            End Session
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="stack">
          <div className="subcard">
            <div className="subheader">Workflow</div>
            <div className="field">
              <label className="label">Select Workflow</label>
              <select
                className="input"
                value={selectedWorkflowId}
                onChange={(e) => loadWorkflow(e.target.value)}
              >
                <option value="">New workflow</option>
                {workflows.map((wf) => (
                  <option key={wf._id} value={wf._id}>
                    {wf.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label">Name</label>
              <input
                className="input"
                value={workflowName}
                onChange={(e) => setWorkflowName(e.target.value)}
                placeholder="Workflow name"
              />
            </div>
            <div className="field">
              <label className="label">Description</label>
              <input
                className="input"
                value={workflowDescription}
                onChange={(e) => setWorkflowDescription(e.target.value)}
                placeholder="Optional description"
              />
            </div>
            <div className="row">
              <button className="btn" onClick={saveWorkflow} disabled={nodes.length === 0}>
                Save Workflow
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setNodes([]);
                  setEdges([]);
                  setWfNodes([]);
                  setSelectedNodeId("");
                }}
              >
                Clear Nodes
              </button>
              {message && <span className="badge subtle">{message}</span>}
              {error && <span className="badge subtle">{error}</span>}
            </div>
          </div>

          <div className="subcard">
            <div className="subheader">Agents Palette (drag into canvas)</div>
            <div className="chips">
              {agents.map((agent) => (
                <div
                  key={agent.slug}
                  className="chip"
                  draggable
                  onDragStart={handleDragStart(agent.slug)}
                  onClick={() => addNode(agent.slug)}
                >
                  {agent.name} ({agent.slug})
                </div>
              ))}
            </div>
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="muted">Drop agents here to build the chain</div>
            </div>
          </div>
        </div>

        <div className="stack">
         <div className="subcard">
            <div className="subheader">Canvas</div>
            <div className="flow-wrapper">
              <ReactFlow
                nodes={layoutNodesForFlow(nodes, edges)}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={(conn) => setEdges((eds) => addEdge(conn, eds))}
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                onDrop={(event) => {
                  event.preventDefault();
                  const slug = event.dataTransfer.getData("text/plain");
                  if (!slug) return;
                  const bounds = (event.target as HTMLDivElement).getBoundingClientRect();
                  const position = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
                  addNode(slug, position);
                }}
                onDragOver={(event) => event.preventDefault()}
                fitView
              >
                <Background gap={16} />
                <MiniMap />
                <Controls />
              </ReactFlow>
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              Drag agents onto the canvas. Connect nodes by dragging edges.
            </div>
          </div>

          <div className="subcard">
            <div className="subheader">Node Inspector</div>
            {!selectedNodeId && <div className="muted">Select a node in the canvas.</div>}
            {selectedNodeId && (
              <div className="stack">
                {(() => {
                  const node = wfNodes.find((n) => n.id === selectedNodeId);
                  if (!node) return <div className="muted">Node not found.</div>;
                  return (
                    <>
                      <div className="row">
                        <strong>{node.label}</strong>
                        <span className="muted">({node.agentSlug})</span>
                        <button className="btn ghost" onClick={() => removeNode(node.id)}>
                          Remove
                        </button>
                      </div>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={node.includeUserPrompt}
                          onChange={() => toggleIncludePrompt(node.id)}
                        />
                        <span>Include original user prompt</span>
                      </label>
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="subcard">
            <div className="subheader">Run Workflow</div>
            <div className="field">
              <label className="label">User Prompt</label>
              <textarea
                className="textarea"
                rows={4}
                value={userMessage}
                onChange={(e) => setUserMessage(e.target.value)}
              />
            </div>
            <button
              className="btn primary"
              onClick={runWorkflow}
              disabled={nodes.length === 0 || loading}
            >
              {loading ? "Running..." : "Run workflow"}
            </button>
            {runResults.length > 0 && (
              <div className="stack" style={{ marginTop: 8 }}>
                {runResults.map((r) => (
                  <div key={r.nodeId} className="row">
                    <label className="checkbox">
                      <input type="checkbox" checked={r.status === "succeeded"} readOnly />
                      <span>
                        {r.agentSlug} — {r.status} (run {r.runId})
                      </span>
                    </label>
                    {r.output && (
                      <button
                        className="btn ghost"
                        onClick={() => {
                          setModalTitle(`${r.agentSlug} output`);
                          setModalContent(r.output);
                        }}
                      >
                        View output
                      </button>
                    )}
                  </div>
                ))}
                {allSucceeded && (
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setModalTitle("Final workflow output");
                      setModalContent(finalOutput ?? {});
                    }}
                  >
                    Show final output
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {modalContent !== null && (
        <div className="modal">
          <div className="modal-body">
            <div className="row">
              <strong>{modalTitle || "Output"}</strong>
              <button
                className="btn ghost"
                onClick={() => {
                  setModalContent(null);
                  setModalTitle("");
                }}
              >
                Close
              </button>
            </div>
            <pre className="code-block">{JSON.stringify(modalContent ?? {}, null, 2)}</pre>
          </div>
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<"home" | "play" | "inspect" | "agents" | "builder">("home");
  const [session, setSession] = useState<SessionState | null>(null);

  useEffect(() => {
    if (!session) return;
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) {
      setSession(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      setSession((current) => {
        if (!current || current.id !== session.id) return current;
        return null;
      });
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [session]);

  const startSession = (id: string) => {
    setSession({ id, expiresAt: Date.now() + SESSION_TTL_MS });
  };

  const endSession = () => {
    setSession(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">A2A</div>
          <div>
            <div className="brand-title">Agents that Create Agents</div>
            <div className="brand-subtitle">Design, run, and inspect agent workflows.</div>
          </div>
        </div>
        <div className="tabs">
          <button className={`tab ${tab === "home" ? "active" : ""}`} onClick={() => setTab("home")}>
            Home
          </button>
          <button className={`tab ${tab === "play" ? "active" : ""}`} onClick={() => setTab("play")}>
            Playground
          </button>
          <button
            className={`tab ${tab === "inspect" ? "active" : ""}`}
            onClick={() => setTab("inspect")}
          >
            Run Inspector
          </button>
          <button
            className={`tab ${tab === "agents" ? "active" : ""}`}
            onClick={() => setTab("agents")}
          >
            Agent Manager
          </button>
          <button
            className={`tab ${tab === "builder" ? "active" : ""}`}
            onClick={() => setTab("builder")}
          >
            Workflow Builder
          </button>
        </div>
      </header>
      <main className="content">
        {tab === "home" && (
          <Home sessionId={session?.id ?? ""} setSessionId={startSession} endSession={endSession} />
        )}
        {tab === "play" && (
          <Playground
            sessionId={session?.id ?? ""}
            setSessionId={startSession}
            endSession={endSession}
          />
        )}
        {tab === "inspect" && <RunInspector />}
        {tab === "agents" && <AgentManager />}
        {tab === "builder" && (
          <WorkflowBuilder
            sessionId={session?.id ?? ""}
            setSessionId={startSession}
            endSession={endSession}
          />
        )}
      </main>
    </div>
  );
}
