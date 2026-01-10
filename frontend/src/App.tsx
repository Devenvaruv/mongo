import { useEffect, useMemo, useState } from "react";
import { Api } from "./api";
import "./index.css";

type AgentOption = { agentId: string; slug: string; name: string };
type SessionState = { id: string; expiresAt: number };
type SessionProps = {
  sessionId: string;
  setSessionId: (id: string) => void;
  endSession: () => void;
};

const SESSION_TTL_MS = 30 * 60 * 1000;

function Home({ sessionId, setSessionId, endSession }: SessionProps) {
  const [agentRequest, setAgentRequest] = useState<string>(
    "Create 2 specialist agents and 1 reviewer agent for a small demo."
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string>("");
  const [runOutput, setRunOutput] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetRunState = () => {
    setRunId(null);
    setRunStatus("");
    setRunOutput(null);
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
  }, [runId]);

  const statusLabel = runStatus || "idle";
  const sessionNote = sessionId ? "Auto-clear after 30 min" : null;

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

export default function App() {
  const [tab, setTab] = useState<"home" | "play" | "inspect" | "agents">("home");
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
      </main>
    </div>
  );
}
