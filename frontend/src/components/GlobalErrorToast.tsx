import { X } from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  message: string;
  onDismiss: () => void;
};

export function GlobalErrorToast(props: Props) {
  const { message, onDismiss } = props;

  return (
    <div
      role="alert"
      className="fixed right-4 top-4 z-50 w-[min(520px,calc(100vw-2rem))] rounded-lg border bg-destructive text-destructive-foreground shadow-lg"
    >
      <div className="flex gap-3 p-4">
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">
          {message}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          className="h-8 w-8 shrink-0 text-destructive-foreground/90 hover:bg-destructive-foreground/10 hover:text-destructive-foreground"
          aria-label="关闭错误提示"
          title="关闭"
        >
          <X />
        </Button>
      </div>
    </div>
  );
}

