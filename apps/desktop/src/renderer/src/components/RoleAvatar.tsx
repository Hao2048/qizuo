/** Color and initials are presentation only; identity always uses the real role id. */
export function roleInitials(name: string, isDefault = false): string {
  if (isDefault) return "TA";
  if (/前端/.test(name)) return "FE";
  if (/后端/.test(name)) return "BE";
  if (/测试/.test(name)) return "TE";
  if (/资料|分析/.test(name)) return "DA";
  return name.slice(0, 2).toUpperCase();
}
export function roleTone(name: string, isDefault = false): string {
  if (isDefault) return "coordinator";
  if (/后端/.test(name)) return "mint";
  if (/测试/.test(name)) return "slate";
  if (/资料|分析/.test(name)) return "peach";
  return "purple";
}
export default function RoleAvatar({
  name,
  isDefault = false,
  small = false,
}: {
  name: string;
  isDefault?: boolean;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`role-avatar ${roleTone(name, isDefault)}${small ? " small" : ""}`}
    >
      {roleInitials(name, isDefault)}
    </span>
  );
}
