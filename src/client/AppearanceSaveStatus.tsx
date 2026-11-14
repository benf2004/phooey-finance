import { useWorkspace } from "./context";
import { Button } from "./ui";

export function AppearanceSaveStatus() {
  const { appearanceSaveState, retryTransactionAppearance } = useWorkspace();
  if (appearanceSaveState.status === "idle") return null;
  if (appearanceSaveState.status === "error")
    return (
      <div className="error-notice" role="alert">
        <span>
          Appearance changes aren’t saved. {appearanceSaveState.error}
        </span>
        <Button
          type="button"
          variant="secondary"
          onClick={retryTransactionAppearance}
        >
          Retry appearance save
        </Button>
      </div>
    );
  return (
    <p className="inline-note" role="status">
      {appearanceSaveState.status === "saving"
        ? "Saving appearance…"
        : "Appearance saved."}
    </p>
  );
}
