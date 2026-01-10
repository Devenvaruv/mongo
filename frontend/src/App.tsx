import { useEffect, useMemo, useState } from "react";
import { Api } from "./api";
import "./index.css";

type AgentOption = { agentId: string; slug: string; name: string };

function Playground() {
  const [sessionId, setSessionId] = useState<string>("");
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

  const createSession = async () => {
    const resp = await Api.createSession("Playground");
    setSessionId(resp.sessionId);
    setRunId(null);
    setEvents([]);
    setRunOutput(null);
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

  return (
    <div className="card">
      <div className="header">
        <div>
          <button onClick={createSession}>Create Session</button>
          <span className="muted"> Session: {sessionId || "none"}</span>
        </div>
        <div>
          <label>Agent </label>
          <select
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
      </div>

      <textarea
        rows={4}
        value={userMessage}
        onChange={(e) => setUserMessage(e.target.value)}
        placeholder="Enter prompt"
      />
      <div>
        <button onClick={startRun} disabled={!sessionId || loading}>
          {loading ? "Running..." : "Run"}
        </button>
        <span className="muted"> Run: {runId || "none"}</span>
        <span className="muted"> Status: {runStatus || "-"}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <div>
          <h3>Events</h3>
          <div className="log">
            {events.map((ev, idx) => (
              <div key={idx} className="log-line">
                <code>{ev.seq}</code> <strong>{ev.type}</strong>{" "}
                <span className="muted">{ev.ts}</span>
                <pre>{JSON.stringify(ev.payload, null, 2)}</pre>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3>Final JSON</h3>
          <pre className="json-box">
            {runOutput ? JSON.stringify(runOutput, null, 2) : "Awaiting output..."}
          </pre>
        </div>
      </div>
    </div>
  );
}

function RunInspector() {
  const [sessionId, setSessionId] = useState("");
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [events, setEvents] = useState<any[]>([]);
  const [runDetail, setRunDetail] = useState<any | null>(null);

  const loadTree = async () => {
    if (!sessionId) return;
    const resp = await Api.getRunTree(sessionId);
    setRuns(resp.runs);
  };

  const grouped = useMemo(() => {
    const byParent: Record<string, any[]> = {};
    runs.forEach((r) => {
      const key = r.parentRunId ?? "root";
      byParent[key] = byParent[key] || [];
      byParent[key].push(r);
    });
    return byParent;
  }, [runs]);

  const renderBranch = (parentId: string | null, depth = 0) => {
    const children = grouped[parentId ?? "root"] || [];
    return children.map((r) => (
      <div key={r._id} style={{ marginLeft: depth * 12 }}>
        <button className="link" onClick={() => selectRun(r._id)}>
          {r._id} [{r.status}]
        </button>
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
    <div className="card">
      <div className="header">
        <input
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          placeholder="Session ID"
        />
        <button onClick={loadTree} disabled={!sessionId}>
          Load Runs
        </button>
      </div>
      <div className="panel">
        <div>
          <h3>Run Tree</h3>
          <div className="log">{renderBranch(null)}</div>
        </div>
        <div>
          <h3>Run Detail</h3>
          <div className="muted">Selected: {selectedRunId || "none"}</div>
          <pre className="json-box">
            {runDetail ? JSON.stringify(runDetail, null, 2) : "Select a run"}
          </pre>
          <h4>Events</h4>
          <div className="log">
            {events.map((ev, idx) => (
              <div key={idx} className="log-line">
                <code>{ev.seq}</code> <strong>{ev.type}</strong>
                <pre>{JSON.stringify(ev.payload, null, 2)}</pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
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
    <div className="card">
      <div className="header">
        <select
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
        <button onClick={loadAgents}>Refresh</button>
        {message && <span className="muted">{message}</span>}
      </div>
      {agentMeta && (
        <>
          <div className="muted">
            Versions: {agentMeta.versions.map((v: any) => v.version).join(", ")}
          </div>
          <textarea
            rows={8}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button onClick={savePrompt} disabled={!prompt}>
            Save new version
          </button>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<"play" | "inspect" | "agents">("play");
  return (
    <div className="layout">
      <header>
        <h1>A2A Agents that Create Agents</h1>
        <nav>
          <button onClick={() => setTab("play")} className={tab === "play" ? "active" : ""}>
            Playground
          </button>
          <button
            onClick={() => setTab("inspect")}
            className={tab === "inspect" ? "active" : ""}
          >
            Run Inspector
          </button>
          <button
            onClick={() => setTab("agents")}
            className={tab === "agents" ? "active" : ""}
          >
            Agent Manager
          </button>
        </nav>
      </header>
      {tab === "play" && <Playground />}
      {tab === "inspect" && <RunInspector />}
      {tab === "agents" && <AgentManager />}
    </div>
  );
}
