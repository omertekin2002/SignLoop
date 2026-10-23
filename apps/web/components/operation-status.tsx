import { stageLabels, type OperationStage } from "@/lib/operation-progress";
import { cn } from "@/lib/utils";

export function OperationStatus({
  stage,
  className,
}: {
  stage: OperationStage | null;
  className?: string;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "text-sm text-muted-foreground",
        className,
        !stage && "sr-only",
      )}
    >
      {stage ? stageLabels[stage] : null}
    </p>
  );
}
