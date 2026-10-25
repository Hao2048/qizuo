import Icon from "../components/Icon.js";
import { useEffect, useState } from "react";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
export default function MarketContext(): React.ReactElement {
  const tab = useStore((s) => s.marketTab),
    source = useStore((s) =>
      s.marketTab === "skills" ? s.skillsSource : s.pluginsSource,
    );
  const [counts, setCounts] = useState<{
    packages: number;
    skills: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([invoke("market:list", {}), invoke("mcp:list", {})])
      .then(([resources, mcp]) => {
        if (!cancelled)
          setCounts({
            packages: resources.packages.length + mcp.servers.length,
            skills: resources.localSkills.length,
          });
      })
      .catch(() => {
        if (!cancelled) setCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);
  return (
    <div className="ctx">
      <div className="ctx-head">
        <h2 className="ctx-title">技能与插件</h2>
      </div>
      <div className="ctx-scroll">
        <div className="seg col market-navigation">
          {(
            [
              ["plugins", "plugin", "插件"],
              ["skills", "spark", "技能"],
              ["installed", "check", "已安装"],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              type="button"
              key={id}
              className={`ctx-item seg-item${tab === id ? " active" : ""}`}
              onClick={() => useStore.getState().setMarketTab(id)}
            >
              <Icon name={icon} size={19} />
              <span className="clamp">{label}</span>
              {id === "installed" && counts && (
                <span className="ctx-count">
                  {counts.packages + counts.skills}
                </span>
              )}
            </button>
          ))}
        </div>
        {
          <>
            <div className="ctx-section">安装来源</div>
            <div role="group" aria-label="市场来源">
              {(
                [
                  ["all", "全部来源"],
                  ["pi", "Pi 社区"],
                  ["claude", "Claude 官方"],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  className={`ctx-item${source === id ? " active" : ""}`}
                  aria-pressed={source === id}
                  onClick={() => {
                    const s = useStore.getState();
                    (tab === "skills" ? s.setSkillsSource : s.setPluginsSource)(
                      id,
                    );
                  }}
                >
                  <span
                    className={`source-dot${source === id ? " active" : ""}`}
                  />
                  {label}
                </button>
              ))}
            </div>
          </>
        }
      </div>
      <p className="context-footnote">
        推荐结合安装趋势、社区热度与工具实用性，每周更新。
      </p>
    </div>
  );
}
