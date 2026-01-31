import { apiGet } from "./client";
import type { Agent } from "../types";

export async function listAgents(): Promise<Agent[]> {
  const data = await apiGet<{ agents: Agent[] }>("/agents");
  return Array.isArray(data.agents) ? data.agents : [];
}
