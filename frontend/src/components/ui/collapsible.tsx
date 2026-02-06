import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

const Collapsible = CollapsiblePrimitive.Root;

const CollapsibleTrigger = React.forwardRef<
    React.ElementRef<typeof CollapsiblePrimitive.Trigger>,
    React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
    <CollapsiblePrimitive.Trigger
        ref={ref}
        className={cn(
            "detailsSummary flex w-full items-center gap-2 text-left [&[data-state=open]_.collapsibleChevron]:rotate-90",
            className,
        )}
        {...props}
    >
        <ChevronRight className="collapsibleChevron h-4 w-4 shrink-0 transition-transform" aria-hidden="true" />
        {children}
    </CollapsiblePrimitive.Trigger>
));
CollapsibleTrigger.displayName = CollapsiblePrimitive.Trigger.displayName;

const CollapsibleContent = React.forwardRef<
    React.ElementRef<typeof CollapsiblePrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(({ className, ...props }, ref) => (
    <CollapsiblePrimitive.Content
        ref={ref}
        className={cn(
            "data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden",
            className,
        )}
        {...props}
    />
));
CollapsibleContent.displayName = CollapsiblePrimitive.Content.displayName;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
