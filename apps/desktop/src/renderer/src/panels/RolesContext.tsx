import Icon from "../components/Icon.js";
import RoleAvatar from "../components/RoleAvatar.js";
import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { refreshRoles } from "../data.js";
export default function RolesContext(): React.ReactElement {
  const roles = useStore((s) => s.roles),
    selected = useStore((s) => s.selectedRoleId);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [query, setQuery] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setError("");
    void refreshRoles(includeArchived).catch((e) => setError(String(e)));
  }, [includeArchived]);
  const visible = roles.filter(
    (r) =>
      (includeArchived || r.status !== "archived") &&
      (r.name + " " + r.intro).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="ctx">
      <div className="ctx-head">
        <h2 className="ctx-title">角色卡</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="新建角色"
          onClick={() => useStore.getState().setSelectedRole("new")}
        >
          <Icon name="plus" size={20} />
        </button>
      </div>
      <div className="ctx-filter">
        <label className="sidebar-search">
          <Icon name="search" size={16} />
          <input
            placeholder="搜索角色…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="ctx-scroll">
        <div className="ctx-section">我的角色 · {roles.length}</div>
        {visible.map((r) => (
          <button
            type="button"
            key={r.id}
            className={`ctx-item role${selected === r.id ? " active" : ""}`}
            onClick={() => useStore.getState().setSelectedRole(r.id)}
          >
            <RoleAvatar name={r.name} isDefault={r.isDefault} small />
            <span className="ctx-item-copy">
              <strong className="clamp">{r.name}</strong>
              <small className="clamp">
                {r.isDefault ? "系统角色，可克隆" : r.intro || "尚未填写简介"}
              </small>
            </span>
            {r.isDefault ? (
              <Icon name="lock" size={14} />
            ) : r.status === "archived" ? (
              <span className="ctx-mode">档</span>
            ) : null}
          </button>
        ))}
        {!visible.length && (
          <div className="ctx-empty">
            {query ? "没有匹配的角色" : "创建第一个角色，定义它的专业能力。"}
          </div>
        )}
        {error && (
          <p className="hint danger" role="alert">
            {error}
          </p>
        )}
      </div>
      <label className="context-archive">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(e) => {
            setIncludeArchived(e.target.checked);
            if (
              !e.target.checked &&
              roles.some((r) => r.id === selected && r.status === "archived")
            )
              useStore.getState().setSelectedRole(null);
          }}
        />
        显示已归档角色
      </label>
      <p className="context-footnote">角色决定工作方式，记忆积累可复用经验。</p>
    </div>
  );
}
