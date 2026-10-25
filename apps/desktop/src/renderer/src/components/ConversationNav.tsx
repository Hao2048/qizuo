import { memo, useEffect, useRef, useState } from "react";
import type { ConversationTurn } from "./conversation.js";
import { scrollBehavior, turnAnchor } from "./conversation.js";
import Icon from "./Icon.js";
function ConversationNav({
  turns,
  scrollRef, onNavigate,
}: {
  turns: ConversationTurn[];
  onNavigate?:(id:string)=>void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}): React.ReactElement | null {
  const [active, setActive] = useState<string | null>(null),
    [expanded, setExpanded] = useState(false);
  const navRef = useRef<HTMLElement>(null),jumpFrame=useRef(0);
  useEffect(()=>()=>cancelAnimationFrame(jumpFrame.current),[]);
  const ids = turns
    .filter((t) => t.user)
    .map((t) => t.id)
    .join("\0");
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame = 0;
    const anchors=Array.from(root.querySelectorAll<HTMLElement>("[data-conversation-turn]"));
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = root.getBoundingClientRect().top + 72;
        let low=0,high=anchors.length-1,found=-1;
        while(low<=high){const mid=(low+high)>>1;if(anchors[mid]!.getBoundingClientRect().top<=top){found=mid;low=mid+1;}else high=mid-1;}
        setActive(anchors[Math.max(0,found)]?.dataset.conversationTurn ?? null);
      });
    };
    const resize =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (root.firstElementChild) resize?.observe(root.firstElementChild);
    root.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", update);
      resize?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ids, scrollRef]);
  const items = turns.filter((t) => t.user);
  if (!items.length) return null;
  return (
    <nav
      ref={navRef}
      className={`conversation-nav${expanded ? " expanded" : ""}`}
      aria-label="对话轮次导航"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => {
        if (!navRef.current?.contains(document.activeElement))
          setExpanded(false);
      }}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setExpanded(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setExpanded(false);
          navRef.current
            ?.querySelector<HTMLButtonElement>(".nav-toggle")
            ?.focus();
        }
      }}
    >
      <button
        type="button"
        className="nav-toggle icon-button"
        aria-label="展开对话导航"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon name="list" size={16} />
      </button>
      <div className="conversation-nav-items">
        {items.map((turn, index) => (
          <button
            type="button"
            key={turn.id}
            className={`conversation-nav-item${active === turn.id ? " active" : ""}`}
            aria-current={active === turn.id ? "location" : undefined}
            aria-label={`跳转到第 ${index + 1} 轮：${(turn.user?.text ?? "附件").slice(0, 80)}`}
            onClick={() => {
              onNavigate?.(turn.id);
              const anchor=document.getElementById(turnAnchor(turn.id)),root=scrollRef.current;
              // Long smooth jumps would mount every intermediate turn along the way.
              const behavior:ScrollBehavior=anchor && root && Math.abs(anchor.getBoundingClientRect().top-root.getBoundingClientRect().top)>root.clientHeight*2 ? "auto" : scrollBehavior();
              anchor?.scrollIntoView({behavior,block:"start"});
              cancelAnimationFrame(jumpFrame.current);
              jumpFrame.current=requestAnimationFrame(()=>document.getElementById(turnAnchor(turn.id))?.scrollIntoView({behavior,block:"start"}));
              setActive(turn.id);
            }}
          >
            <span className="nav-tick" />
            {expanded ? (
              <span className="nav-summary">
                <span className="nav-index">{index + 1}</span>
                <span>{turn.user?.text || "附件"}</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </nav>
  );
}

export default memo(ConversationNav);
