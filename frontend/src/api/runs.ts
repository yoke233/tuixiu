import { apiGet, apiPost } from "./client";
import type { Event, Run } from "../types";

export async function getRun(id: string): Promise<Run> {
  const data = await apiGet<{ run: Run }>(`/runs/${id}`);
  return data.run;
}

export async function listRunEvents(runId: string): Promise<Event[]> {
  const data = await apiGet<{ events: Event[] }>(`/runs/${runId}/events`);
  return data.events;
}

export async function cancelRun(id: string): Promise<Run> {
  const data = await apiPost<{ run: Run }>(`/runs/${id}/cancel`, {});
  return data.run;
}

