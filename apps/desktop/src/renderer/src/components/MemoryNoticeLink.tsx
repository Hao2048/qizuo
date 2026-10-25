import { useStore } from "../store.js";
export default function MemoryNoticeLink() {
  const ref = useStore((s) => s.notice?.memoryRef);
  if (!ref) return null;
  return (
    <button
      type="button"
      className="ghost"
      onClick={() => {
        useStore.setState({
          memoryScope: "role",
          memoryRoleId: ref.roleId,
          memoryStatus: "active",
          memoryVerification: "all",
          memoryQuery: "",
          selectedMemoryId: ref.id,
        });
        useStore.getState().setTool("memory");
        useStore.getState().setNotice(null);
      }}
    >
      查看记忆
    </button>
  );
}
