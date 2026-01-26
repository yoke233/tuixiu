import { z } from "zod";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function truthyEnv(value: string | undefined): boolean {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : trimmed;
}

function extractFirstJsonObject(text: string): unknown | null {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    // best-effort: find outermost {...}
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const sliced = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch {
      return null;
    }
  }
}

export function isPmLlmEnabled(): boolean {
  const baseUrl = String(process.env.PM_LLM_BASE_URL ?? "").trim();
  const apiKey =
    String(process.env.PM_LLM_API_KEY ?? "").trim() ||
    String(process.env.OPENAI_API_KEY ?? "").trim() ||
    String(process.env.CODEX_API_KEY ?? "").trim();
  return Boolean(baseUrl || apiKey);
}

export function isPmAutomationEnabled(): boolean {
  return truthyEnv(process.env.PM_AUTOMATION_ENABLED);
}

export async function callPmLlmJson<T>(opts: {
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<{ ok: true; value: T; rawText: string; model: string } | { ok: false; error: string }> {
  if (!isPmLlmEnabled()) return { ok: false, error: "PM_LLM_DISABLED" };

  const model = String(process.env.PM_LLM_MODEL ?? "").trim() || "gpt-4o-mini";
  const baseUrl = (String(process.env.PM_LLM_BASE_URL ?? "").trim() || "https://api.openai.com").replace(/\/+$/g, "");
  const apiKey =
    String(process.env.PM_LLM_API_KEY ?? "").trim() ||
    String(process.env.OPENAI_API_KEY ?? "").trim() ||
    String(process.env.CODEX_API_KEY ?? "").trim();

  const timeoutMsRaw = Number(process.env.PM_LLM_TIMEOUT_MS ?? 15000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.min(timeoutMsRaw, 60000) : 15000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: typeof opts.temperature === "number" ? opts.temperature : 0.2,
        max_tokens: typeof opts.maxTokens === "number" ? opts.maxTokens : 400,
        messages: opts.messages,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `PM_LLM_HTTP_${res.status} ${text}`.trim() };
    }

    const data = (await res.json().catch(() => null)) as any;
    const content = String(data?.choices?.[0]?.message?.content ?? "");
    const rawText = content.trim();
    if (!rawText) return { ok: false, error: "PM_LLM_EMPTY" };

    const parsed = extractFirstJsonObject(rawText);
    if (!parsed) return { ok: false, error: "PM_LLM_BAD_JSON" };

    const validated = opts.schema.safeParse(parsed);
    if (!validated.success) return { ok: false, error: `PM_LLM_SCHEMA ${validated.error.message}` };

    return { ok: true, value: validated.data, rawText, model };
  } catch (err) {
    return { ok: false, error: `PM_LLM_FAILED ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

