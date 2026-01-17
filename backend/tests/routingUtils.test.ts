import { describe, expect, it } from "vitest";
import {
  buildAgentSummaryItem,
  buildRouterIndex,
  buildSpecialistIndex,
  extractDomainsFromTags,
  inferRoleFromTags,
  mergeStringArrays,
  normalizeStringArray,
  readRoutingState,
  summarizeAvailableAgents,
  summarizePreviousResults,
} from "../src/routingUtils";

describe("routingUtils", () => {
  it("normalizes string arrays", () => {
    const input = ["alpha", " ", "", 3, "beta"] as unknown;
    expect(normalizeStringArray(input)).toEqual(["alpha", "beta"]);
    expect(normalizeStringArray("nope")).toEqual([]);
  });

  it("merges string arrays with stable uniqueness", () => {
    expect(mergeStringArrays(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("infers roles and domains from tags", () => {
    expect(inferRoleFromTags(["specialist"])).toBe("specialist");
    expect(inferRoleFromTags(["domain-router"])).toBe("router");
    expect(inferRoleFromTags(["router", "specialist"])).toBe("router");
    expect(inferRoleFromTags(["misc"])).toBeUndefined();
    expect(extractDomainsFromTags(["domain:backend", "domain: frontend", "misc"])).toEqual([
      "backend",
      "frontend",
    ]);
  });

  it("builds agent summary items with inferred metadata", () => {
    const summary = buildAgentSummaryItem({
      slug: "router-backend",
      name: "Backend Router",
      description: "Routes backend tasks",
      metadata: {
        tags: ["router", "domain:backend", "priority"],
        capabilities: ["routing"],
        hidden: true,
      },
    });
    expect(summary.domains).toEqual(["backend"]);
    expect(summary.role).toBe("router");
    expect(summary.hidden).toBe(true);
    expect(summary.system).toBe(false);
  });

  it("infers domain and role from name/slug when metadata is missing", () => {
    const summary = buildAgentSummaryItem({
      slug: "marketing_specialist",
      name: "Marketing Specialist",
    });
    expect(summary.role).toBe("specialist");
    expect(summary.domains).toEqual(["marketing"]);
  });

  it("falls back to name when description is missing", () => {
    const summary = buildAgentSummaryItem({ slug: "spec", name: "Spec Agent" });
    expect(summary.description).toBe("Spec Agent");
  });

  it("summarizes available agents", () => {
    const agents = [
      {
        slug: "r1",
        name: "R1",
        description: "R1",
        tags: ["a"],
        domains: ["backend"],
        capabilities: [],
        role: "router" as const,
        system: false,
        hidden: false,
      },
      {
        slug: "s1",
        name: "S1",
        description: "S1",
        tags: ["a", "b"],
        domains: ["backend"],
        capabilities: [],
        role: "specialist" as const,
        system: false,
        hidden: false,
      },
      {
        slug: "sys",
        name: "Sys",
        description: "Sys",
        tags: [],
        domains: [],
        capabilities: [],
        system: true,
        hidden: true,
      },
    ];
    const summary = summarizeAvailableAgents(agents);
    expect(summary.total).toBe(3);
    expect(summary.byDomain).toEqual({ backend: 2, unspecified: 1 });
    expect(summary.byRole).toEqual({ router: 1, specialist: 1, system: 1 });
    expect(summary.topTags).toEqual({ a: 2, b: 1 });
  });

  it("builds router and specialist indexes", () => {
    const agents = [
      buildAgentSummaryItem({
        slug: "company_router",
        name: "Company Router",
        metadata: { tags: ["router", "domain:company"] },
      }),
      buildAgentSummaryItem({
        slug: "finance_specialist",
        name: "Finance Specialist",
        metadata: { tags: ["specialist", "domain:finance"] },
      }),
      buildAgentSummaryItem({
        slug: "ops_specialist",
        name: "Operations Specialist",
        metadata: { tags: ["specialist", "domain:operations"] },
      }),
    ];
    const routers = buildRouterIndex(agents, 10);
    expect(routers).toEqual([
      {
        slug: "company_router",
        name: "Company Router",
        description: "Company Router",
        domains: ["company"],
        tags: ["router", "domain:company"],
      },
    ]);
    const specialists = buildSpecialistIndex(agents, 10, ["operations"]);
    expect(specialists).toEqual([
      {
        slug: "ops_specialist",
        name: "Operations Specialist",
        description: "Operations Specialist",
        domains: ["operations"],
        tags: ["specialist", "domain:operations"],
      },
    ]);
  });

  it("reads routing state defensively", () => {
    const state = readRoutingState({
      routingState: { visitedSlugs: ["a", 2], routingDepth: -1 },
    });
    expect(state).toEqual({ visitedSlugs: ["a"], routingDepth: 0 });
    const state2 = readRoutingState({
      routingState: { visitedSlugs: ["x"], routingDepth: "2" },
    });
    expect(state2).toEqual({ visitedSlugs: ["x"], routingDepth: 0 });
  });

  it("summarizes previous results without large payloads", () => {
    const long = "a".repeat(210);
    const summary = summarizePreviousResults({
      text: long,
      list: [1, 2, 3],
      obj: { x: 1, y: 2 },
      num: 3,
    });
    expect(summary.text).toBe(`${long.slice(0, 200)}...(truncated)`);
    expect(summary.list).toEqual({ type: "array", length: 3 });
    expect(summary.obj).toEqual({ type: "object", keys: ["x", "y"], truncated: false });
    expect(summary.num).toBe(3);
  });
});
