import { useEffect, useMemo, useState } from "react";
import { Api } from "./api";
import "./index.css";

type AgentOption = { agentId: string; slug: string; name: string };
type SessionState = { id: string; expiresAt: number };
type PlaygroundProps = {
  sessionId: string;
  setSessionId: (id: string) => void;
  endSession: () => void;
};

const SESSION_TTL_MS = 30 * 60 * 1000;

function Playground({ sessionId, setSessionId, endSession }: PlaygroundProps) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string>("bootstrap");
  const [userMessage, setUserMessage] = useState<string>("Plan a demo with 2 helpers");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [nextSeq, setNextSeq] = useState<number>(0);
  const [runOutput, setRunOutput] = useState<any>(null);
  const [runStatus, setRunStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = async () => {
    const resp = await Api.listAgents();
    const opts: AgentOption[] = [
      { agentId: "bootstrap", slug: "bootstrap", name: "Bootstrap (hardcoded)" },
      ...resp.agents.map((a) => ({ agentId: a.agentId, slug: a.slug, name: a.name })),
    ];
    setAgents(opts);
  };

  useEffect(() => {
    loadAgents().catch((err) => setError(err.message));
  }, []);

  const resetRunState = () => {
    setRunId(null);
    setEvents([]);
    setRunOutput(null);
    setRunStatus("");
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

  const startRun = async () => {
    if (!sessionId) {
      setError("Create a session first");
      return;
    }
    setLoading(true);
    setError(null);
    setEvents([]);
    setRunOutput(null);
    try {
      const resp = await Api.startRun({
        sessionId,
        agentSlug: selectedAgentSlug,
        userMessage,
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
              <span className="status" data-status={statusLabel}>
                Status: {statusLabel}
              </span>
            </div>
          </div>

          <div className="field">
            <label className="label">Agent</label>
            <select
              className="input"
              value={selectedAgentSlug}
              onChange={(e) => setSelectedAgentSlug(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.name} ({a.slug})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label">Prompt</label>
            <textarea
              className="textarea"
              rows={5}
              value={userMessage}
              onChange={(e) => setUserMessage(e.target.value)}
              placeholder="Enter prompt"
            />
          </div>

          <div className="row">
            <button className="btn primary" onClick={startRun} disabled={!sessionId || loading}>
              {loading ? "Running..." : "Run"}
            </button>
            <span className="badge subtle">Run ID: {runId || "none"}</span>
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

  useEffect(() => {
    loadAgents().catch((err) => setMessage(err.message));
  }, []);

  const selectAgent = async (id: string) => {
    setSelectedAgentId(id);
    const resp = await Api.getAgent(id, undefined);
    setAgentMeta(resp);
    setPrompt(resp.activeVersion?.systemPrompt || "");
  };

  const savePrompt = async () => {
    if (!selectedAgentId) return;
    await Api.updatePrompt(selectedAgentId, prompt);
    setMessage("Saved new version");
    await selectAgent(selectedAgentId);
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
            <div className="badge subtle">
              Versions: {agentMeta.versions.map((v: any) => v.version).join(", ")}
            </div>
          )}
        </div>

        <div className="stack">
          {!agentMeta ? (
            <div className="empty">Select an agent to edit its system prompt.</div>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<"play" | "inspect" | "agents">("play");
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
