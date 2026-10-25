import MemoryNoticeLink from "./components/MemoryNoticeLink.js";
import {
  CollaborationContext,
  CollaborationPanel,
} from "./panels/Collaboration.js";
import { useEffect, useState } from "react";
import { invoke, onEvent } from "./api.js";
import { useStore } from "./store.js";
import { dispatchAppEvent } from "./events.js";
import "./appearance.js";
import Icon from "./components/Icon.js";
import TaskActivityPanel from "./components/TaskActivityPanel.js";
import IconRail from "./components/IconRail.js";
import WorkbenchContext from "./panels/WorkbenchContext.js";
import ChatPanel from "./panels/ChatPanel.js";
import RolesContext from "./panels/RolesContext.js";
import RoleDetail from "./panels/RoleDetail.js";
import MemoryContext from "./panels/MemoryContext.js";
import MemoryDetail from "./panels/MemoryDetail.js";
import MarketContext from "./panels/MarketContext.js";
import MarketDetail from "./panels/MarketDetail.js";
import SettingsContext from "./panels/SettingsContext.js";
import SettingsDetail from "./panels/SettingsDetail.js";
import SmokeRunner from "./components/SmokeRunner.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { QuestionModal } from "./components/QuestionModal.js";
import { ForkDialog } from "./components/M7Widgets.js";

const CONTEXT: Record<string, React.ReactElement> = {
  workbench: <WorkbenchContext />,
  collaboration: <CollaborationContext />,
  roles: <RolesContext />,
  memory: <MemoryContext />,
  market: <MarketContext />,
  settings: <SettingsContext />,
};

const DETAIL: Record<string, React.ReactElement> = {
  workbench: <ChatPanel />,
  collaboration: <CollaborationPanel />,
  roles: <RoleDetail />,
  memory: <MemoryDetail />,
  market: <MarketDetail />,
  settings: <SettingsDetail />,
};

export default function App(): React.ReactElement {
  const tool = useStore((s) => s.tool);
  const notice = useStore((s) => s.notice);
  const [collapsed, setCollapsed] = useState(false);
  const isSmoke =
    new URLSearchParams(window.location.search).get("smoke") === "1";

  useEffect(()=>{
    let active=true;
    void invoke("time-memory:attention",{}).then(result=>{if(active&&result.count>0)useStore.getState().setNotice({level:"info",message:`有 ${result.count} 项时间记忆已错过或中断，未自动补跑。请在角色记忆页选择是否补执行。`});}).catch(()=>{});
    return()=>{active=false;};
  },[]);

  useEffect(() => {
    try {
      return onEvent((e) => dispatchAppEvent(e));
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (document.querySelector('[role="dialog"],.modal-mask')) return;
        const s = useStore.getState();
        if (s.tool === "collaboration") {
          window.dispatchEvent(new Event("pih:new-workbench"));
          return;
        }
        s.selectTask(null);
        s.resetConversation();
        s.setTool("workbench");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="desktop-window">
      <header className="desktop-titlebar">
        <span className="desktop-title">栖作 Qizuo</span>
        <div className="desktop-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            title="切换侧栏 (⌘B)"
            onClick={() => setCollapsed((v) => !v)}
          >
            <Icon name="sidebar" size={16} />
          </button>
          <TaskActivityPanel />
          <button
            type="button"
            className="ghost sm"
            title="查看 MCP 连接、认证与失败原因"
            onClick={() => {
              useStore.getState().setTool("settings");
              useStore.getState().setSettingsSection("mcp");
            }}
          >
            MCP
          </button>
        </div>
      </header>
      <div
        className={`shell${collapsed ? " sidebar-collapsed" : ""}`}
        data-tool={tool}
      >
        <IconRail />
        <aside
          className="app-sidebar"
          aria-label="功能选项与任务"
          hidden={collapsed}
        >
          <div className="context-col" key={`ctx-${tool}`}>
            {CONTEXT[tool]}
          </div>
          <button
            type="button"
            className="sidebar-command"
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true }),
              )
            }
          >
            <Icon name="search" size={16} />
            搜索与命令<kbd>⌘K</kbd>
          </button>
        </aside>
        <main className="detail-col" key={`dt-${tool}`}>
          {DETAIL[tool]}
        </main>
      </div>
      {notice && tool !== "workbench" && (
        <div
          className={`global-notice ${notice.level}`}
          role={notice.level === "error" ? "alert" : "status"}
        >
          <span>{notice.message}</span><MemoryNoticeLink/>
          <button
            type="button"
            aria-label="关闭通知"
            onClick={() => useStore.getState().setNotice(null)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      <CommandPalette />
      <QuestionModal />
      <ForkDialog />
      {isSmoke ? <SmokeRunner /> : null}
    </div>
  );
}
