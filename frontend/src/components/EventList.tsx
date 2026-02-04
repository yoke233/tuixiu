import type { Event } from "@/types";

export function EventList(props: { events: Event[] }) {
  if (!props.events.length) return <div className="muted">暂无事件</div>;

  return (
    <ul className="list">
      {props.events.map((e) => (
        <li key={e.id} className="listItem">
          <div className="row spaceBetween">
            <div>
              <code>{e.type}</code> <span className="muted">({e.source})</span>
            </div>
            <div className="muted">{new Date(e.timestamp).toLocaleString()}</div>
          </div>
          {e.payload ? (
            <pre className="pre">{JSON.stringify(e.payload, null, 2)}</pre>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

