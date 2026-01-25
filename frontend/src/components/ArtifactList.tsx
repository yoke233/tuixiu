import type { Artifact } from "../types";

export function ArtifactList(props: { artifacts: Artifact[] }) {
  if (!props.artifacts.length) return <div className="muted">暂无产物</div>;

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
          <pre className="pre">{JSON.stringify(a.content, null, 2)}</pre>
        </li>
      ))}
    </ul>
  );
}

