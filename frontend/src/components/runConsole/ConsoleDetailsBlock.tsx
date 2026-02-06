import { useState, type ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export function ConsoleDetailsBlock(props: {
  className: string;
  bordered?: boolean;
  defaultOpen?: boolean;
  summary: ReactNode;
  body: ReactNode;
  bodyClassName?: string;
}) {
  const [open, setOpen] = useState(Boolean(props.defaultOpen));

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={`${props.className}${props.bordered ? " consoleDetailsBorder" : ""}`}
    >
      <CollapsibleTrigger>
        <span className="toolSummaryRow">{props.summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={props.bodyClassName ?? "pre"}>{props.body}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
