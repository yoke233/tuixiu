import { SessionConsoleCard } from "./sections/SessionConsoleCard";
import { SessionMobileHeader } from "./sections/SessionMobileHeader";
import { SessionSidebar } from "./sections/SessionSidebar";
import { useSessionController } from "./useSessionController";

export function SessionPage() {
  const model = useSessionController();

  return (
    <div className="sessionShell">
      <SessionSidebar model={model} />

      <main className="sessionMain">
        <SessionMobileHeader model={model} />

        {model.error ? (
          <div role="alert" className="alert">
            {model.error}
          </div>
        ) : null}

        <SessionConsoleCard model={model} />
      </main>
    </div>
  );
}

