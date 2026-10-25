import { useStore, type PageId } from "../store.js";
import brand from "../assets/brand.svg";
import Icon, { type IconName } from "./Icon.js";
const TOOLS: { id: PageId; label: string; icon: IconName }[] = [
  { id: "workbench", label: "对话", icon: "chat" },
  { id: "collaboration", label: "工作台", icon: "grid" },
  { id: "roles", label: "角色卡", icon: "person" },
  { id: "memory", label: "记忆", icon: "memory" },
  { id: "market", label: "Skill 与插件", icon: "plugin" },
  { id: "settings", label: "模型与设置", icon: "settings" },
];
export default function IconRail(): React.ReactElement {
  const tool = useStore((s) => s.tool);
  return (
    <nav className="rail" aria-label="工具导航">
      <div className="app-brand" title="栖作 · Qizuo">
        <img className="brand-icon" src={brand} alt="栖作 Qizuo" draggable={false}/>
      </div>
      <div className="rail-links">
        {TOOLS.map((t) => (
          <button
            type="button"
            key={t.id}
            className={`rail-item${tool === t.id ? " active" : ""}${t.id === "settings" ? " rail-settings" : ""}`}
            aria-label={t.label}
            title={t.label}
            aria-current={tool === t.id ? "page" : undefined}
            onClick={() => useStore.getState().setTool(t.id)}
          >
            <Icon name={t.icon} />
            <span className="rail-caption">
              {t.id === "memory"
                ? "记忆"
                : t.id === "market"
                  ? "技能插件"
                  : t.id === "settings"
                    ? "设置"
                    : t.label}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
