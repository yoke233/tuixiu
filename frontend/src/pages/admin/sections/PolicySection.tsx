import { useCallback, useEffect, useState } from "react";

import { getPmPolicy, updatePmPolicy } from "../../../api/policies";
import type { PmPolicy, Project } from "../../../types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  active: boolean;
  effectiveProjectId: string;
  effectiveProject: Project | null;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
};

export function PolicySection(props: Props) {
  const { active, effectiveProjectId, effectiveProject, requireAdmin, setError } = props;

  const [policyText, setPolicyText] = useState<string>("");
  const [policySource, setPolicySource] = useState<"project" | "default" | "">("");
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);

  useEffect(() => {
    if (!active) return;
    if (!effectiveProjectId) return;

    let cancelled = false;
    setPolicyLoading(true);
    setError(null);
    void (async () => {
      try {
        const { policy, source } = await getPmPolicy(effectiveProjectId);
        if (cancelled) return;
        setPolicySource(source);
        setPolicyText(JSON.stringify(policy, null, 2));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          setPolicyLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, effectiveProjectId, setError]);

  const onLoadDefault = useCallback(() => {
    setPolicyText(
      JSON.stringify(
        {
          version: 1,
          automation: {
            autoStartIssue: true,
            autoReview: true,
            autoCreatePr: true,
            autoRequestMergeApproval: true,
          },
          approvals: { requireForActions: ["merge_pr"], escalateOnSensitivePaths: ["create_pr", "publish_artifact"] },
          sensitivePaths: [],
        } satisfies PmPolicy,
        null,
        2,
      ),
    );
  }, []);

  const onSave = useCallback(async () => {
    if (!effectiveProjectId) return;
    if (!requireAdmin()) return;
    setPolicySaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(policyText || "{}") as PmPolicy;
      const res = await updatePmPolicy(effectiveProjectId, parsed);
      setPolicySource("project");
      setPolicyText(JSON.stringify(res.policy, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicySaving(false);
    }
  }, [effectiveProjectId, policyText, requireAdmin, setError]);

  return (
    <section className="card" style={{ marginBottom: 16 }} hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>策略（Policy）</h2>
          <div className="muted">
            {effectiveProject ? (
              <>
                Project: <code>{effectiveProject.name}</code>
                {policySource ? ` · source: ${policySource}` : ""}
              </>
            ) : (
              "请先创建/选择 Project"
            )}
          </div>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onLoadDefault}
            disabled={!effectiveProjectId || policyLoading || policySaving}
          >
            载入默认
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void onSave()}
            disabled={!effectiveProjectId || policyLoading || policySaving}
          >
            {policySaving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>

      {policyLoading ? (
        <div className="muted" style={{ marginTop: 10 }}>
          加载中…
        </div>
      ) : (
        <Textarea
          value={policyText}
          onChange={(e) => setPolicyText(e.target.value)}
          rows={14}
          className="inputMono mt-2 w-full"
          placeholder='{"version":1,"automation":{"autoStartIssue":true,"autoReview":true,"autoCreatePr":true,"autoRequestMergeApproval":true},"approvals":{"requireForActions":["merge_pr"],"escalateOnSensitivePaths":["create_pr","publish_artifact"]},"sensitivePaths":[] }'
        />
      )}

      <details style={{ marginTop: 12 }}>
        <summary>字段说明</summary>
        <div className="muted" style={{ marginTop: 8 }}>
          <div>
            <code>version</code>：配置版本号（当前固定为 <code>1</code>）。
          </div>
          <div>
            <code>automation</code>：自动化开关集合（创建 Issue / Review / 创建 PR / 自动请求合并审批）。
          </div>
          <div>
            <code>approvals.requireForActions</code>：这些动作必须人工审批（如 <code>merge_pr</code>）。
          </div>
          <div>
            <code>approvals.escalateOnSensitivePaths</code>：命中敏感目录时，强制审批的动作列表（如 <code>create_pr</code>）。
          </div>
          <div>
            动作枚举：<code>merge_pr</code> / <code>create_pr</code> / <code>publish_artifact</code>。
          </div>
          <div>
            <code>sensitivePaths</code>：敏感路径规则数组（支持 glob，例如 <code>backend/**</code>、<code>.env*</code>）。
          </div>
          <div style={{ marginTop: 6 }}>
            后端校验：<code>backend/src/services/pm/pmPolicy.ts</code>（Zod：<code>pmPolicyV1Schema</code>，<code>.strict()</code>）。
          </div>
        </div>
      </details>

      <details style={{ marginTop: 10 }}>
        <summary>示例</summary>
        <pre className="pre">{`{
  "version": 1,
  "automation": {
    "autoStartIssue": true,
    "autoReview": true,
    "autoCreatePr": true,
    "autoRequestMergeApproval": true
  },
  "approvals": {
    "requireForActions": ["merge_pr"],
    "escalateOnSensitivePaths": ["create_pr", "publish_artifact"]
  },
  "sensitivePaths": ["backend/**", ".env*"]
}`}</pre>
      </details>

      <details style={{ marginTop: 10 }}>
        <summary>JSON Schema / 结构</summary>
        <pre className="pre">{`{
  "type": "object",
  "properties": {
    "version": { "type": "integer", "enum": [1] },
    "automation": {
      "type": "object",
      "properties": {
        "autoStartIssue": { "type": "boolean" },
        "autoReview": { "type": "boolean" },
        "autoCreatePr": { "type": "boolean" },
        "autoRequestMergeApproval": { "type": "boolean" }
      },
      "additionalProperties": false
    },
    "approvals": {
      "type": "object",
      "properties": {
        "requireForActions": {
          "type": "array",
          "items": { "type": "string", "enum": ["merge_pr", "create_pr", "publish_artifact"] }
        },
        "escalateOnSensitivePaths": {
          "type": "array",
          "items": { "type": "string", "enum": ["merge_pr", "create_pr", "publish_artifact"] }
        }
      },
      "additionalProperties": false
    },
    "sensitivePaths": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["version"],
  "additionalProperties": false
}`}</pre>
        <div className="muted" style={{ marginTop: 6 }}>
          结构层级固定为 <code>version/automation/approvals/sensitivePaths</code>；未填写字段会按后端默认值补全，且不允许额外字段。
        </div>
      </details>

      <div className="muted" style={{ marginTop: 8 }}>
        后端接口：<code>GET/PUT /api/policies?projectId=...</code>（存储在 <code>Project.branchProtection.pmPolicy</code>）。
      </div>
    </section>
  );
}
