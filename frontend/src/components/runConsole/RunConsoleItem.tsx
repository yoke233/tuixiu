import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConsoleDetailsBlock } from "@/components/runConsole/ConsoleDetailsBlock";
import { ConsoleRichContent } from "@/components/runConsole/consoleRichContent";
import {
    type BadgeTone,
    exitToTone,
    getToolTitle,
    kindToTone,
    priorityToTone,
    statusToTone,
} from "@/components/runConsole/toolCallInfo";
import type { ConsoleItem, PermissionUiProps } from "@/components/runConsole/types";
import { parseSandboxInstanceStatusText } from "@/utils/sandboxStatus";

const INIT_STAGE_LABELS: Record<string, string> = {
    auth: "鉴权准备",
    clone: "项目拉取",
    checkout: "切换分支",
    ready: "环境就绪",
};

const INIT_STATUS_LABELS: Record<string, string> = {
    start: "开始",
    progress: "进行中",
    done: "完成",
    error: "失败",
};

function ToneBadge(props: { tone: BadgeTone; children: ReactNode }) {
    if (props.tone === "success") {
        return (
            <Badge className="bg-success text-success-foreground hover:bg-success/80">
                {props.children}
            </Badge>
        );
    }
    if (props.tone === "warning") {
        return (
            <Badge className="bg-warning text-warning-foreground hover:bg-warning/80">
                {props.children}
            </Badge>
        );
    }
    if (props.tone === "danger") {
        return <Badge variant="destructive">{props.children}</Badge>;
    }
    if (props.tone === "info") {
        return <Badge className="bg-info text-info-foreground hover:bg-info/80">{props.children}</Badge>;
    }
    return <Badge variant="secondary">{props.children}</Badge>;
}

function initStatusTone(status: string): BadgeTone {
    if (status === "done") return "success";
    if (status === "start") return "info";
    if (status === "progress") return "warning";
    if (status === "error" || status === "failed") return "danger";
    return "neutral";
}

function splitFirstLine(text: string): { firstLine: string; rest: string } {
    const input = String(text ?? "");
    if (!input) return { firstLine: "", rest: "" };
    const lf = input.indexOf("\n");
    if (lf === -1) return { firstLine: input.replace(/\r$/, ""), rest: "" };
    return { firstLine: input.slice(0, lf).replace(/\r$/, ""), rest: input.slice(lf + 1) };
}

function renderInlineMarkdown(text: string): ReactNode {
    const input = String(text ?? "");
    if (!input) return null;

    const nodes: ReactNode[] = [];
    let i = 0;
    let key = 0;

    while (i < input.length) {
        const nextBold = input.indexOf("**", i);
        const nextCode = input.indexOf("`", i);
        const next = Math.min(
            nextBold === -1 ? Number.POSITIVE_INFINITY : nextBold,
            nextCode === -1 ? Number.POSITIVE_INFINITY : nextCode,
        );

        if (next === Number.POSITIVE_INFINITY) {
            nodes.push(<span key={`t-${key++}`}>{input.slice(i)}</span>);
            break;
        }

        if (next > i) {
            nodes.push(<span key={`t-${key++}`}>{input.slice(i, next)}</span>);
            i = next;
        }

        if (input.startsWith("**", i)) {
            const end = input.indexOf("**", i + 2);
            if (end === -1) {
                nodes.push(<span key={`t-${key++}`}>{"**"}</span>);
                i += 2;
                continue;
            }
            nodes.push(<strong key={`b-${key++}`}>{input.slice(i + 2, end)}</strong>);
            i = end + 2;
            continue;
        }

        if (input[i] === "`") {
            const end = input.indexOf("`", i + 1);
            if (end === -1) {
                nodes.push(<span key={`t-${key++}`}>{"`"}</span>);
                i += 1;
                continue;
            }
            nodes.push(<code key={`c-${key++}`}>{input.slice(i + 1, end)}</code>);
            i = end + 1;
            continue;
        }

        nodes.push(<span key={`t-${key++}`}>{input[i]}</span>);
        i += 1;
    }

    return <>{nodes}</>;
}

function extractPermissionReason(toolCall: unknown): string | null {
    if (!toolCall || typeof toolCall !== "object") return null;

    const tc = toolCall as any;
    const content = tc.content;
    if (!Array.isArray(content) || !content.length) return null;

    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const inner = (item as any).content;
        if (inner && typeof inner === "object" && typeof inner.text === "string") {
            const t = inner.text.trim();
            if (t) parts.push(t);
        } else if (typeof (item as any).text === "string") {
            const t = String((item as any).text).trim();
            if (t) parts.push(t);
        }
    }

    if (!parts.length) return null;
    return parts.join("\n");
}

export function RunConsoleItem(props: { item: ConsoleItem; permission?: PermissionUiProps }) {
    const { item, permission } = props;

    if (item.role === "system" && item.plan) {
        const entries = item.plan.entries;
        const counts = entries.reduce(
            (acc, e) => {
                if (e.status === "completed") acc.completed += 1;
                else if (e.status === "in_progress") acc.in_progress += 1;
                else acc.pending += 1;
                return acc;
            },
            { completed: 0, in_progress: 0, pending: 0 },
        );
        return (
            <ConsoleDetailsBlock
                className={`consoleItem ${item.role}`}
                defaultOpen
                summary={
                    <>
                        <ToneBadge tone="neutral">PLAN</ToneBadge>
                        <span className="toolSummaryTitle">
                            计划（{counts.completed}/{entries.length}）
                        </span>
                        {counts.in_progress ? (
                            <ToneBadge tone="warning">in_progress {counts.in_progress}</ToneBadge>
                        ) : null}
                        {counts.pending ? <ToneBadge tone="neutral">pending {counts.pending}</ToneBadge> : null}
                    </>
                }
                bodyClassName="planBody"
                body={
                    <div className="planList">
                        {entries.map((e, idx) => (
                            <div key={`${idx}-${e.status}-${e.content}`} className="planItem">
                                <ToneBadge tone={statusToTone(e.status)}>{e.status}</ToneBadge>
                                {e.priority ? <ToneBadge tone={priorityToTone(e.priority)}>{e.priority}</ToneBadge> : null}
                                <span className="planContent">{e.content}</span>
                            </div>
                        ))}
                    </div>
                }
            />
        );
    }

    if (item.role === "system" && item.initStep) {
        const stageLabel = INIT_STAGE_LABELS[item.initStep.stage] ?? item.initStep.stage;
        const statusLabel = INIT_STATUS_LABELS[item.initStep.status] ?? item.initStep.status;
        return (
            <div className="consoleItem system consoleInitStep">
                <ToneBadge tone="neutral">INIT</ToneBadge>
                <ToneBadge tone={initStatusTone(item.initStep.status)}>{statusLabel}</ToneBadge>
                <span className="toolSummaryTitle">{stageLabel}</span>
                {item.initStep.message ? <span className="consoleInitMessage">{item.initStep.message}</span> : null}
            </div>
        );
    }

    if (item.role === "system" && item.permissionRequest) {
        const req = item.permissionRequest;
        const toolCall = req.toolCall as any;
        const title =
            typeof toolCall?.title === "string" && toolCall.title.trim()
                ? toolCall.title.trim()
                : "工具调用权限";
        const kind =
            typeof toolCall?.kind === "string" && toolCall.kind.trim() ? toolCall.kind.trim() : null;
        const reason = extractPermissionReason(toolCall);
        const busy = permission?.resolvingRequestId === req.requestId;
        const resolved = permission?.resolvedRequestIds?.has(req.requestId) ?? false;
        const isAdmin = permission?.isAdmin ?? false;
        const canDecide = Boolean(permission?.onDecide) && isAdmin && !busy && !resolved;
        const titleHint = !permission?.onDecide
            ? "当前页面未启用审批操作"
            : !isAdmin
                ? "需要管理员权限"
                : resolved
                    ? "已处理"
                    : busy
                        ? "处理中…"
                        : "";

        return (
            <div className="consoleItem system" style={{ display: "grid", gap: 6, whiteSpace: "normal" }}>
                <div className="row gap" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
                    <ToneBadge tone="warning">PERMISSION</ToneBadge>
                    {kind ? <ToneBadge tone={kindToTone(kind)}>{kind}</ToneBadge> : null}
                    {resolved ? (
                        <ToneBadge tone="success">resolved</ToneBadge>
                    ) : busy ? (
                        <ToneBadge tone="warning">processing</ToneBadge>
                    ) : (
                        <ToneBadge tone="neutral">pending</ToneBadge>
                    )}
                    <span className="toolSummaryTitle">{title}</span>
                </div>

                <div className="muted" style={{ fontSize: 12 }}>
                    requestId={req.requestId}
                    {req.promptId ? ` · prompt=${req.promptId}` : ""}
                </div>

                {reason ? (
                    <div className="pre" style={{ marginTop: 0 }}>
                        {reason}
                    </div>
                ) : null}

                <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                    {req.options.map((o) => {
                        const label = (o.name ?? "").trim() || (o.kind ?? "").trim() || o.optionId;
                        const secondary = String(o.kind ?? "").startsWith("reject");
                        return (
                            <Button
                                key={o.optionId}
                                type="button"
                                variant={secondary ? "secondary" : "default"}
                                size="sm"
                                disabled={!canDecide}
                                title={titleHint}
                                onClick={() =>
                                    permission?.onDecide?.({
                                        requestId: req.requestId,
                                        sessionId: req.sessionId,
                                        outcome: "selected",
                                        optionId: o.optionId,
                                    })
                                }
                            >
                                {label}
                            </Button>
                        );
                    })}

                    {!req.options.length ? (
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={!canDecide}
                            title={titleHint}
                            onClick={() =>
                                permission?.onDecide?.({
                                    requestId: req.requestId,
                                    sessionId: req.sessionId,
                                    outcome: "cancelled",
                                })
                            }
                        >
                            取消
                        </Button>
                    ) : null}

                    {!permission?.onDecide ? (
                        <span className="muted">（当前页面未接入审批按钮）</span>
                    ) : !isAdmin ? (
                        <span className="muted">仅管理员可审批</span>
                    ) : resolved ? (
                        <span className="muted">已处理</span>
                    ) : null}
                </div>
            </div>
        );
    }

    if (item.role === "user" && item.kind === "chunk" && item.chunkType === "user_message") {
        return (
            <div className={`consoleItem ${item.role}`}>
                <span className="consoleNewTag" title="new" aria-label="new">
                    !
                </span>
                <ConsoleRichContent text={item.text} />
            </div>
        );
    }

    if (item.role === "agent" && item.kind === "chunk" && item.chunkType === "agent_thought") {
        const { firstLine, rest } = splitFirstLine(item.text);
        const summaryTitle = firstLine || "思考";
        return (
            <ConsoleDetailsBlock
                className={`consoleItem ${item.role}`}
                bordered
                defaultOpen={Boolean(item.live)}
                summary={
                    <>
                        <ToneBadge tone="neutral">THINK</ToneBadge>
                        <span className="toolSummaryTitle">{renderInlineMarkdown(summaryTitle)}</span>
                    </>
                }
                body={
                    <>
                        {renderInlineMarkdown(firstLine || item.text)}
                        {rest ? `\n${rest}` : null}
                    </>
                }
            />
        );
    }

    if (item.role === "system" && item.detailsTitle) {
        return (
            <ConsoleDetailsBlock
                className={`consoleItem ${item.role}`}
                summary={
                    <>
                        <ToneBadge tone="neutral">INFO</ToneBadge>
                        <span className="toolSummaryTitle">{item.detailsTitle}</span>
                    </>
                }
                body={item.text}
            />
        );
    }

    if (item.role === "system") {
        const sandbox = parseSandboxInstanceStatusText(item.text);
        if (sandbox) return null;
    }

    if (item.role === "system" && item.toolCallInfo) {
        return (
            <ConsoleDetailsBlock
                className={`consoleItem ${item.role}`}
                summary={
                    <>
                        <ToneBadge tone="neutral">TOOL</ToneBadge>
                        {item.toolCallInfo.kind ? (
                            <ToneBadge tone={kindToTone(item.toolCallInfo.kind)}>{item.toolCallInfo.kind}</ToneBadge>
                        ) : null}
                        {item.toolCallInfo.status ? (
                            <ToneBadge tone={statusToTone(item.toolCallInfo.status)}>{item.toolCallInfo.status}</ToneBadge>
                        ) : null}
                        {typeof item.toolCallInfo.exitCode === "number" ? (
                            <ToneBadge tone={exitToTone(item.toolCallInfo.exitCode)}>
                                exit {item.toolCallInfo.exitCode}
                            </ToneBadge>
                        ) : null}
                        <span className="toolSummaryTitle">{getToolTitle(item.toolCallInfo)}</span>
                    </>
                }
                body={item.text}
            />
        );
    }

    return (
        <div className={`consoleItem ${item.role}`}>
            {item.role === "user" ? (
                <>
                    <span>{`你: `}</span>
                    <ConsoleRichContent text={item.text} />
                </>
            ) : (
                <ConsoleRichContent text={item.text} />
            )}
        </div>
    );
}
