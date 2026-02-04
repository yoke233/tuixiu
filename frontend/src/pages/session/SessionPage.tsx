import { SessionConsoleCard } from "@/pages/session/sections/SessionConsoleCard";
import { SessionMobileHeader } from "@/pages/session/sections/SessionMobileHeader";
import { SessionSidebar } from "@/pages/session/sections/SessionSidebar";
import { useSessionController } from "@/pages/session/useSessionController";
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
