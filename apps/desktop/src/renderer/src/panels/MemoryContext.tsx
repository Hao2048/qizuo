import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { refreshRoles, refreshMemories } from "../data.js";
import Icon from "../components/Icon.js";
import RoleAvatar from "../components/RoleAvatar.js";
export default function MemoryContext(): React.ReactElement {
  const scope = useStore((s) => s.memoryScope),
    roleId = useStore((s) => s.memoryRoleId),
    roles = useStore((s) => s.roles),
    query = useStore((s) => s.memoryQuery);
  useEffect(() => {
    if (roles.length && (!roleId || !roles.some((r) => r.id === roleId)))
      useStore.setState({
        memoryScope: "role",
        memoryRoleId: roles[0]!.id,
        selectedMemoryId: null,
      });
  }, [roles, roleId]);
  useEffect(() => {
    void refreshRoles().catch(() => {});
  }, []);
  const status = useStore((s) => s.memoryStatus);
  const verification=useStore(s=>s.memoryVerification);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    void refreshMemories({
      status,
      scopeType: "role",
      scopeId: scope === "role" ? (roleId ?? undefined) : undefined,
      query: query || undefined,
    }).catch((e) => {
      if (active) setError(String(e));
    });
    return () => {
      active = false;
    };
  }, [scope, roleId, query, status, verification]);
  return (
    <div className="ctx">
      <div className="ctx-head">
        <h2 className="ctx-title">记忆</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="新增角色记忆"
          onClick={() => window.dispatchEvent(new Event("pih:new-memory"))}
        >
          <Icon name="plus" size={20} />
        </button>
      </div>
      <div className="ctx-filter">
        <label className="sidebar-search">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => useStore.getState().setMemoryQuery(e.target.value)}
            placeholder="搜索记忆…"
            aria-label="搜索记忆"
          />
        </label>
      </div>
      <div className="ctx-scroll">
        <div className="ctx-section">按角色查看</div>
        {roles.map((role) => (
          <button
            type="button"
            key={role.id}
            className={`ctx-item role${scope === "role" && roleId === role.id ? " active" : ""}`}
            onClick={() =>
              useStore.setState({
                memoryScope: "role",
                memoryRoleId: role.id,
                selectedMemoryId: null,
              })
            }
          >
            <RoleAvatar name={role.name} isDefault={role.isDefault} small />
            <span className="clamp">{role.name}</span>
            <span className="ctx-count">{role.memoryCount}</span>
          </button>
        ))}
        {error && (
          <p className="hint danger" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="context-footnote">长期记忆与时间记忆按角色独立管理。</p>
    </div>
  );
}
