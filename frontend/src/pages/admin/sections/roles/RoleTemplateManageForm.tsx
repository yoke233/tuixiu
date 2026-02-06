import type { ReactNode, RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type RoleTemplateManageMode = "create" | "edit";

export type RoleTemplateManageFormProps = {
    mode: RoleTemplateManageMode;
    roleKey: string;
    roleKeyInputRef?: RefObject<HTMLInputElement | null>;
    onRoleKeyChange?: (next: string) => void;
    roleKeyReadOnly?: boolean;
    displayName: string;
    onDisplayNameChange: (next: string) => void;
    description: string;
    onDescriptionChange: (next: string) => void;
    promptTemplate: string;
    onPromptTemplateChange: (next: string) => void;
    agentsMdText?: string;
    onAgentsMdTextChange?: (next: string) => void;
    initScript: string;
    onInitScriptChange: (next: string) => void;
    initTimeoutSeconds: string;
    onInitTimeoutSecondsChange: (next: string) => void;
    envText: string;
    onEnvTextChange: (next: string) => void;
    envTextEnabled?: boolean;
    onEnvTextEnabledChange?: (next: boolean) => void;
    envKeysHint?: string[] | null;
    submitLabel: string;
    submitBusy?: boolean;
    submitDisabled?: boolean;
    onCancel: () => void;
    onClear?: () => void;
    children?: ReactNode;
};

export function RoleTemplateManageForm(props: RoleTemplateManageFormProps) {
    const {
        mode,
        roleKey,
        roleKeyInputRef,
        onRoleKeyChange,
        roleKeyReadOnly,
        displayName,
        onDisplayNameChange,
        description,
        onDescriptionChange,
        promptTemplate,
        onPromptTemplateChange,
        agentsMdText,
        onAgentsMdTextChange,
        initScript,
        onInitScriptChange,
        initTimeoutSeconds,
        onInitTimeoutSecondsChange,
        envText,
        onEnvTextChange,
        envTextEnabled,
        onEnvTextEnabledChange,
        envKeysHint,
        submitLabel,
        submitBusy,
        submitDisabled,
        onCancel,
        onClear,
        children,
    } = props;

    return (
        <div className="stack" style={{ gap: 16 }}>
            <div className="rounded-lg border bg-card p-4">
                <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 800 }}>基础配置</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                        必填：Role Key / 显示名称
                    </div>
                </div>
                <div className="stack" style={{ gap: 12, marginTop: 12 }}>
                    <label className="label">
                        Role Key *
                        <Input
                            ref={roleKeyInputRef}
                            value={roleKey}
                            onChange={(e) => onRoleKeyChange?.(e.target.value)}
                            readOnly={roleKeyReadOnly}
                            placeholder="backend-dev"
                        />
                    </label>

                    <div className="row gap" style={{ flexWrap: "wrap" }}>
                        <label className="label" style={{ flex: 1, minWidth: 260 }}>
                            显示名称 *
                            <Input
                                value={displayName}
                                onChange={(e) => onDisplayNameChange(e.target.value)}
                                placeholder={mode === "create" ? "后端开发" : undefined}
                            />
                        </label>
                        <label className="label" style={{ flex: 2, minWidth: 320 }}>
                            描述（可选）
                            <Input
                                value={description}
                                onChange={(e) => onDescriptionChange(e.target.value)}
                                placeholder={mode === "create" ? "用于选择/提示的简短说明" : undefined}
                            />
                        </label>
                    </div>

                    <label className="label">
                        角色指令（AGENTS.md / Prompt Template，可选）
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            推荐只维护这一份内容；保存时会写入 Prompt Template，并可同步到 Agent 文件里的{" "}
                            <code>.codex/AGENTS.md</code>（若启用 Agent 文件）。
                        </div>
                        <Textarea
                            value={agentsMdText ?? promptTemplate}
                            onChange={(e) => {
                                const v = e.target.value;
                                onPromptTemplateChange(v);
                                onAgentsMdTextChange?.(v);
                            }}
                            placeholder={mode === "create" ? "你是 {{role.name}}，请优先写单测。" : undefined}
                        />
                    </label>

                    <label className="label">
                        initScript（bash，可选）
                        <Textarea
                            value={initScript}
                            onChange={(e) => onInitScriptChange(e.target.value)}
                            placeholder={mode === "create" ? "# 可使用环境变量：TUIXIU_WORKSPACE 等\n\necho init" : undefined}
                        />
                    </label>

                    <label className="label">
                        init 超时秒数（可选）
                        <Input
                            value={initTimeoutSeconds}
                            onChange={(e) => onInitTimeoutSecondsChange(e.target.value)}
                            placeholder="300"
                        />
                    </label>
                </div>
            </div>

            <div className="rounded-lg border bg-card p-4">
                <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 800 }}>
                        envText（仅 admin）
                        {envKeysHint?.length ? (
                            <span className="muted" style={{ marginLeft: 8, fontWeight: 500 }}>
                                keys: {envKeysHint.join(", ")}
                            </span>
                        ) : null}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                        可选：用于注入环境变量
                    </div>
                </div>
                <div className="stack" style={{ gap: 10, marginTop: 12 }}>
                    {mode === "edit" ? (
                        <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                            <Checkbox
                                checked={envTextEnabled === true}
                                onCheckedChange={(v) => onEnvTextEnabledChange?.(v === true)}
                            />
                            <div className="muted">勾选后允许编辑并保存（留空=清空）。</div>
                        </div>
                    ) : null}
                    <Textarea
                        value={envText}
                        onChange={(e) => onEnvTextChange(e.target.value)}
                        rows={4}
                        readOnly={mode === "edit" ? envTextEnabled !== true : false}
                        placeholder={"FOO=bar\nexport TOKEN=xxx"}
                    />
                </div>
            </div>

            {children}

            <div className="row gap" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                <Button type="submit" disabled={submitDisabled === true}>
                    {submitBusy ? "保存中…" : submitLabel}
                </Button>
                {onClear ? (
                    <Button type="button" variant="secondary" onClick={onClear}>
                        清空
                    </Button>
                ) : (
                    <Button type="button" variant="secondary" onClick={onCancel}>
                        取消
                    </Button>
                )}
            </div>
        </div>
    );
}
