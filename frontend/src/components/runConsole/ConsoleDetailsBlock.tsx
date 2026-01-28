import type { ReactNode } from "react";

export function ConsoleDetailsBlock(props: {
  className: string;
  bordered?: boolean;
  defaultOpen?: boolean;
  summary: ReactNode;
  body: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <details className={`${props.className}${props.bordered ? " consoleDetailsBorder" : ""}`} open={props.defaultOpen}>
      <summary className="detailsSummary">
        <span className="toolSummaryRow">
          {props.summary}
          <span className="detailsCaret">▸</span>
        </span>
      </summary>
      <div className={props.bodyClassName ?? "pre"}>{props.body}</div>
    </details>
  );
}

