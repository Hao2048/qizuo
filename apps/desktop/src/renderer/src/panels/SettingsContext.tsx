import Icon, { type IconName } from "../components/Icon.js";
import { useStore, type SettingsSection } from "../store.js";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: IconName }> =
  [
    { id: "model", label: "模型与思考", icon: "spark" },
    { id: "connections", label: "账号与连接", icon: "plugin" },
    { id: "mcp", label: "MCP 服务", icon: "terminal" },
    { id: "approval", label: "权限与审批", icon: "shield" },
    { id: "prefs", label: "外观与偏好", icon: "settings" },
    { id: "backup", label: "数据与备份", icon: "inbox" },
    { id: "about", label: "关于软件", icon: "info" },
  ];

/** 设置中列：分类导航。 */
export default function SettingsContext(): React.ReactElement {
  const section = useStore((s) => s.settingsSection);
  return (
    <div className="ctx">
      <div className="ctx-head">
        <h2 className="ctx-title">设置</h2>
      </div>
      <div className="ctx-scroll">
        {SECTIONS.map((s) => (
          <button
            type="button"
            key={s.id}
            className={`ctx-item${section === s.id ? " active" : ""}`}
            onClick={() => useStore.getState().setSettingsSection(s.id)}
          >
            <span className="ctx-ico">
              <Icon name={s.icon} size={16} />
            </span>
            <span className="clamp">{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
