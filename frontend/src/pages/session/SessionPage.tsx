import { SessionConsoleCard } from "./sections/SessionConsoleCard";
import { SessionMobileHeader } from "./sections/SessionMobileHeader";
import { SessionSidebar } from "./sections/SessionSidebar";
import { useSessionController } from "./useSessionController";

export function SessionPage() {
  const model = useSessionController();
  const visibleError = model.error;

  return (
    <div className="sessionShell">
      <SessionSidebar model={model} />

      <main className="sessionMain">
        <SessionMobileHeader model={model} />

        {visibleError ? (
          <div role="alert" className="alert">
            {visibleError}
          </div>
        ) : null}

        <SessionConsoleCard model={model} />
      </main>
    </div>
  );
}
