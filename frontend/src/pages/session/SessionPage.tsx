import { SessionConsoleCard } from "./sections/SessionConsoleCard";
import { SessionMobileHeader } from "./sections/SessionMobileHeader";
import { SessionSidebar } from "./sections/SessionSidebar";
import { useSessionController } from "./useSessionController";
import { GlobalErrorToast } from "@/components/GlobalErrorToast";

export function SessionPage() {
  const model = useSessionController();
  const visibleError = model.error;

  return (
    <div className="sessionShell">
      <SessionSidebar model={model} />

      <main className="sessionMain">
        <SessionMobileHeader model={model} />

        {visibleError ? (
          <GlobalErrorToast message={visibleError} onDismiss={model.clearError} />
        ) : null}

        <SessionConsoleCard model={model} />
      </main>
    </div>
  );
}
