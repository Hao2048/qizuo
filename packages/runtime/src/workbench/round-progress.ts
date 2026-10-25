import type { Workbench } from "@pi-harness/contracts";
type Stage = NonNullable<Workbench["roundProgress"]>["roles"][number]["stage"];

/** Display metadata only. No changes to task status, permissions or dependency scheduling. */
export function setRoundStage(w: Workbench, requestId: string, roleId: string, stage: Stage): void {
  if(w.roundProgress?.requestId!==requestId)return;
  const role=w.roundProgress.roles.find(r=>r.roleId===roleId);
  if(role)role.stage=stage;
}

export function interruptRoundProgress(w: Workbench): void {
  for(const role of w.roundProgress?.roles??[])
    if(role.stage!=="finished")role.stage="interrupted";
}
