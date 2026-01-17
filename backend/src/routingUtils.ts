import { AgentMetadata } from "./models";

export type AgentSummaryItem = {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  domains: string[];
  capabilities: string[];
  role?: AgentMetadata["role"];
  system: boolean;
  hidden: boolean;
};

export type RoutingState = {
  visitedSlugs: string[];
  routingDepth: number;
};

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string" && item.trim().length > 0) as string[];
}

function normalizeDomainValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDomains(values: string[]): string[] {
  return values.map(normalizeDomainValue).filter((value) => value.length > 0);
}

export function mergeStringArrays(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

export function normalizeAgentRole(
  metadata: AgentMetadata | undefined
): AgentMetadata["role"] | undefined {
  const role = metadata?.role;
  if (role === "system" || role === "router" || role === "specialist") {
    return role;
  }
  return undefined;
}

export function inferRoleFromTags(tags: string[]): AgentMetadata["role"] | undefined {
  if (tags.includes("router") || tags.includes("domain-router")) {
    return "router";
  }
  if (tags.includes("specialist")) {
    return "specialist";
  }
  return undefined;
}

function inferRoleFromLabel(label: string): AgentMetadata["role"] | undefined {
  const normalized = label.toLowerCase();
  if (normalized.includes("router")) {
    return "router";
  }
  if (normalized.includes("specialist")) {
    return "specialist";
  }
  return undefined;
}

function inferDomainFromSlug(slug: string): string | undefined {
  const normalized = slug.toLowerCase();
  const suffixes = ["_router", "-router", "_specialist", "-specialist"];
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix)) {
      const raw = normalized.slice(0, -suffix.length).replace(/[-_]+/g, " ").trim();
      if (raw) {
        return normalizeDomainValue(raw);
      }
    }
  }
  return undefined;
}

function inferDomainFromName(name: string): string | undefined {
  const normalized = name.toLowerCase();
  const suffixes = [" router", " specialist"];
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix)) {
      const raw = normalized.slice(0, -suffix.length).trim();
      if (raw) {
        return normalizeDomainValue(raw);
      }
    }
  }
  return undefined;
}

function inferDomainsFromLabels(name: string, slug: string): string[] {
  const inferred: string[] = [];
  const fromSlug = inferDomainFromSlug(slug);
  if (fromSlug) {
    inferred.push(fromSlug);
  }
  const fromName = inferDomainFromName(name);
  if (fromName) {
    inferred.push(fromName);
  }
  return inferred;
}

export function extractDomainsFromTags(tags: string[]): string[] {
  const domains: string[] = [];
  for (const tag of tags) {
    if (tag.startsWith("domain:")) {
      const domain = normalizeDomainValue(tag.slice("domain:".length));
      if (domain) {
        domains.push(domain);
      }
    }
  }
  return domains;
}

export function buildAgentSummaryItem(agent: {
  slug: string;
  name: string;
  description?: string;
  metadata?: AgentMetadata | null;
}): AgentSummaryItem {
  const metadata = agent.metadata ?? {};
  const tags = normalizeStringArray(metadata.tags);
  const domainFromTags = extractDomainsFromTags(tags);
  const domainsFromMeta = normalizeDomains(normalizeStringArray(metadata.domains));
  const domains = mergeStringArrays(domainsFromMeta, domainFromTags);
  const capabilities = normalizeStringArray(metadata.capabilities);
  const inferredRole = inferRoleFromTags(tags) ?? inferRoleFromLabel(`${agent.name} ${agent.slug}`);
  const role = normalizeAgentRole(metadata) ?? inferredRole;
  const system = metadata.system === true;
  const hidden = metadata.hidden === true;
  if (domains.length === 0) {
    const inferredDomains = inferDomainsFromLabels(agent.name, agent.slug);
    domains.push(...inferredDomains);
  }
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description ?? agent.name,
    tags,
    domains,
    capabilities,
    role: role ?? (system ? "system" : undefined),
    system,
    hidden,
  };
}

export type RouterIndexItem = {
  slug: string;
  name: string;
  description: string;
  domains: string[];
  tags: string[];
};

export function buildRouterIndex(
  agents: AgentSummaryItem[],
  limit: number
): RouterIndexItem[] {
  const routers = agents.filter((agent) => agent.role === "router" && !agent.hidden);
  return routers.slice(0, limit).map((agent) => ({
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    domains: agent.domains,
    tags: agent.tags,
  }));
}

export type SpecialistIndexItem = {
  slug: string;
  name: string;
  description: string;
  domains: string[];
  tags: string[];
};

export function buildSpecialistIndex(
  agents: AgentSummaryItem[],
  limit: number,
  domains: string[]
): SpecialistIndexItem[] {
  const normalizedDomains = normalizeDomains(domains);
  const specialists = agents.filter(
    (agent) => agent.role === "specialist" && !agent.hidden
  );
  const filtered =
    normalizedDomains.length === 0
      ? specialists
      : specialists.filter((agent) =>
          agent.domains.some((domain) => normalizedDomains.includes(domain))
        );
  return filtered.slice(0, limit).map((agent) => ({
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    domains: agent.domains,
    tags: agent.tags,
  }));
}

function topCounts(counts: Record<string, number>, limit: number) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
  return entries.reduce<Record<string, number>>((acc, [key, count]) => {
    acc[key] = count;
    return acc;
  }, {});
}

export function summarizeAvailableAgents(agents: AgentSummaryItem[]) {
  const byDomain: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  for (const agent of agents) {
    const role = agent.role ?? (agent.system ? "system" : "unspecified");
    byRole[role] = (byRole[role] ?? 0) + 1;
    const domains = agent.domains.length > 0 ? agent.domains : ["unspecified"];
    for (const domain of domains) {
      byDomain[domain] = (byDomain[domain] ?? 0) + 1;
    }
    for (const tag of agent.tags) {
      byTag[tag] = (byTag[tag] ?? 0) + 1;
    }
  }
  return {
    total: agents.length,
    byDomain,
    byRole,
    topTags: topCounts(byTag, 12),
  };
}

export function readRoutingState(context?: Record<string, unknown>): RoutingState {
  const state = (context?.routingState ?? {}) as Partial<RoutingState>;
  const visitedSlugs = normalizeStringArray(state.visitedSlugs);
  const depthValue = state.routingDepth;
  const routingDepth =
    typeof depthValue === "number" && Number.isFinite(depthValue) ? depthValue : 0;
  return {
    visitedSlugs,
    routingDepth: routingDepth < 0 ? 0 : routingDepth,
  };
}

export function summarizeResultForContext(value: unknown) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (value.length <= 200) {
      return value;
    }
    return `${value.slice(0, 200)}...(truncated)`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return {
      type: "object",
      keys: keys.slice(0, 20),
      truncated: keys.length > 20,
    };
  }
  return String(value);
}

export function summarizePreviousResults(results: Record<string, unknown>) {
  const summary: Record<string, unknown> = {};
  for (const [slug, value] of Object.entries(results)) {
    summary[slug] = summarizeResultForContext(value);
  }
  return summary;
}
