import {
  AgentResponse,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  PlanAgentSpec,
} from "./models";

interface CallModelOptions {
  mockPlan?: AgentResponse;
}

const DEFAULT_MODEL = "gpt-4o-mini";

export async function callModel(
  request: ModelRequest,
  opts: CallModelOptions = {}
): Promise<ModelResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { content: JSON.stringify(opts.mockPlan ?? buildMockPlan(request)) };
  }

  const body = {
    model: request.model || DEFAULT_MODEL,
    temperature: request.temperature ?? 0.2,
    messages: request.messages,
    response_format: { type: "json_object" },
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Model call failed with status ${resp.status}: ${text.slice(0, 500)}`
    );
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Model response missing content");
  }

  return { content };
}

function buildMockPlan(request: ModelRequest): AgentResponse {
  const userMessage =
    request.messages.find((m: ModelMessage) => m.role === "user")?.content ??
    "";

  const echoAgent: PlanAgentSpec = {
    slug: "mock-echo",
    name: "Mock Echo",
    description: "Echoes the user input inside a JSON final result.",
    systemPrompt: `You are Mock Echo. Output JSON only: {"type":"final","result":{"echo":<string>,"notes":<array>}}. Echo the userMessage field verbatim and add 2 bullet notes.`,
    routingHints: { tags: ["mock"], preferredModel: DEFAULT_MODEL },
    ioSchema: { output: {} },
  };

  const wantsFinal = userMessage.toLowerCase().includes("final only");
  if (wantsFinal) {
    return {
      type: "final",
      result: {
        mock: true,
        echo: userMessage,
      },
    };
  }

  return {
    type: "plan",
    agentsToCreate: [echoAgent],
    runsToExecute: [
      {
        slug: echoAgent.slug,
        userMessage: `Echo this back: ${userMessage}`,
      },
    ],
    mergeStrategy: "compose",
  };
}
