import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { publishArtifact } from "@/api/artifacts";
import { useAuth } from "@/auth/AuthContext";
import type { Artifact } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ArtifactList(props: { artifacts: Artifact[] }) {
  if (!props.artifacts.length) return <div className="muted">暂无产物</div>;
  return <ArtifactListBody artifacts={props.artifacts} />;
}

function ArtifactListBody(props: { artifacts: Artifact[] }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<Record<string, { path: string; commitSha: string }>>({});
  const [publishError, setPublishError] = useState<Record<string, string>>({});

  async function onPublish(id: string) {
    if (!auth.user) {
      const next = encodeURIComponent(`${location.pathname}${location.search}`);
      navigate(`/login?next=${next}`);
      return;
    }

    setPublishingId(id);
    setPublishError((prev) => ({ ...prev, [id]: "" }));
    try {
      const path = paths[id]?.trim();
      const res = await publishArtifact(id, path ? { path } : undefined);
      setPublishResult((prev) => ({ ...prev, [id]: res }));
    } catch (e) {
      setPublishError((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setPublishingId(null);
    }
  }

  return (
    <ul className="list">
      {props.artifacts.map((a) => (
        <li key={a.id} className="listItem">
          <div className="row spaceBetween">
            <div>
              <code>{a.type}</code>
            </div>
            <div className="muted">{new Date(a.createdAt).toLocaleString()}</div>
          </div>
          {a.type === "report" || a.type === "ci_result" ? (
            <div style={{ marginTop: 10 }}>
              <div className="row gap" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
                <label className="label" style={{ margin: 0, minWidth: 320 }}>
                  发布路径（可选）
                  <Input
                    value={paths[a.id] ?? ""}
                    onChange={(e) => setPaths((prev) => ({ ...prev, [a.id]: e.target.value }))}
                    placeholder="留空则使用默认 docs/tuixiu/..."
                    disabled={publishingId === a.id}
                  />
                </label>
                <Button type="button" size="sm" onClick={() => void onPublish(a.id)} disabled={publishingId === a.id}>
                  {publishingId === a.id ? "发布中…" : "发布到分支"}
                </Button>
              </div>
              {publishError[a.id] ? (
                <div className="muted" style={{ marginTop: 6 }}>
                  发布失败：{publishError[a.id]}
                </div>
              ) : null}
              {publishResult[a.id] ? (
                <div className="muted" style={{ marginTop: 6 }}>
                  已发布：<code>{publishResult[a.id]!.path}</code> · commit <code>{publishResult[a.id]!.commitSha}</code>
                </div>
              ) : null}
            </div>
          ) : null}
          <pre className="pre">{JSON.stringify(a.content, null, 2)}</pre>
        </li>
      ))}
    </ul>
  );
}

