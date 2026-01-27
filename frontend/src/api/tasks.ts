import { apiGet, apiPost } from "./client";
import type { Task, TaskTemplate, TaskTrack } from "../types";

export async function listTaskTemplates(): Promise<TaskTemplate[]> {
  const data = await apiGet<{ templates: TaskTemplate[] }>("/task-templates");
  return data.templates;
}

export async function listIssueTasks(issueId: string): Promise<Task[]> {
  const data = await apiGet<{ tasks: Task[] }>(`/issues/${issueId}/tasks`);
  return data.tasks;
}

export async function createIssueTask(issueId: string, input: { templateKey: string; track?: TaskTrack }): Promise<Task> {
  const data = await apiPost<{ task: Task }>(`/issues/${issueId}/tasks`, input);
  return data.task;
}

export async function getTask(taskId: string): Promise<Task> {
  const data = await apiGet<{ task: Task }>(`/tasks/${taskId}`);
  return data.task;
}

