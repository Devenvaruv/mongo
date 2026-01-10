import { ObjectId } from "mongodb";

export type CreatedByType = "system" | "user" | "agent";

export interface CreatedBy {
  type: CreatedByType;
  refId?: ObjectId;
}

export interface AgentDoc {
  _id: ObjectId;
  slug: string;
  name: string;
  description?: string;
  activeVersionId: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  createdBy: CreatedBy;
}

export interface AgentVersionDoc {
  _id: ObjectId;
  agentId: ObjectId;
  version: number;
  systemPrompt: string;
  resources?: Array<{ type: string; ref: string }>;
  ioSchema: {
    output: Record<string, unknown>;
  };
  routingHints?: {
    tags?: string[];
    preferredModel?: string;
    temperature?: number;
  };
  createdAt: Date;
  createdBy: CreatedBy;
}

export interface SessionDoc {
  _id: ObjectId;
  title?: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface RunDoc {
  _id: ObjectId;
  sessionId: ObjectId;
  agentId: ObjectId | null;
  agentVersionId: ObjectId | null;
  status: RunStatus;
  parentRunId: ObjectId | null;
  rootRunId?: ObjectId | null;
  input: { userMessage: string; context?: Record<string, unknown> };
  output?: { result: Record<string, unknown> };
  error?: { message: string; stack?: string; lastEventSeq?: number };
  startedAt: Date;
  endedAt?: Date;
}

export type EventType =
  | "RUN_STARTED"
  | "PROMPT_LOADED"
  | "MODEL_REQUEST"
  | "MODEL_RESPONSE"
  | "SPAWN_AGENT_REQUEST"
  | "SPAWN_AGENT_CREATED"
  | "CHILD_RUN_STARTED"
  | "CHILD_RUN_FINISHED"
  | "RUN_FINISHED"
  | "ERROR";

export interface EventDoc {
  _id: ObjectId;
  runId: ObjectId;
  seq: number;
  ts: Date;
  type: EventType;
  payload: Record<string, unknown>;
}

export interface PlanAgentSpec {
  slug: string;
  name: string;
  description?: string;
  systemPrompt: string;
  resources?: Array<{ type: string; ref: string }>;
  ioSchema?: { output: Record<string, unknown> };
  routingHints?: {
    tags?: string[];
    preferredModel?: string;
    temperature?: number;
  };
}

export interface PlanRunSpec {
  slug: string;
  userMessage?: string;
  context?: Record<string, unknown>;
}

export interface AgentPlanResponse {
  type: "plan";
  agentsToCreate?: PlanAgentSpec[];
  runsToExecute?: PlanRunSpec[];
  mergeStrategy?: "compose";
}

export interface AgentFinalResponse {
  type: "final";
  result: Record<string, unknown>;
}

export type AgentResponse = AgentPlanResponse | AgentFinalResponse;

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
}

export interface ModelResponse {
  content: string;
}
