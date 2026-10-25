import PageHeader from "../components/PageHeader.js";
import Icon from "../components/Icon.js";
import { useEffect, useState, useRef } from "react";
import type {
  InstalledPackageInfo,
  InstalledSkillInfo,
  McpServerInfo,
  MarketAuthInfo,
} from "@pi-harness/contracts";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
import { PluginAuthModal } from "../components/PluginAuthModal.js";

const PAGE_SIZE = 8;

/** 统一目录卡：来源 × 页面（安装方式）决定行为。 */
interface CatalogCard {
  key: string;
  source?: string;
  installable?: boolean;
  compatibility?: string;
  auth?: boolean;
  reasons?: string[];
  origin: "pi" | "claude";
  name: string;
  description: string;
  /** meta 行（下载量 / 许可证等） */
  meta: string;
  downloads: number | null;
  /** Claude 官方市场 MCP 型插件：安装 = 接入 MCP 服务器（已安装态按服务器判定） */
  mcpPlugin?: boolean;
  install: (operationId: string) => Promise<void>;
}

/** 市场右列：插件/技能统一目录页（双源可切、已安装态、详情弹窗、推荐+精品）。 */
export default function MarketDetail(): React.ReactElement {
  const tab = useStore((s) => s.marketTab);
  if (tab === "installed") return <InstalledDetail />;
  if (tab === "skills") return <CatalogPage key="skills" kind="skills" />;
  return <CatalogPage key="plugins" kind="plugins" />;
}

/* ---------------- 页面骨架 ---------------- */

function MarketShell({
  title,
  sub,
  actions,
  children,
}: {
  title: string;
  sub: string;
  actions: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="detail market2">
      <PageHeader section="技能与插件" title={title} />
      <div className="page-scroll">
        <div className="market-body">
          <p className="hint">{sub}</p>
          <div className="market-toolbar">{actions}</div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** 分页条 + 卡片网格切片。 */
function usePaged<T>(items: T[]): {
  page: number;
  totalPages: number;
  slice: T[];
  setPage: (n: number) => void;
} {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  useEffect(() => {
    setPage(0);
  }, [items]);
  return {
    page: safePage,
    totalPages,
    slice: items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    setPage,
  };
}

function PageBar({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (n: number) => void;
}): React.ReactElement | null {
  if (totalPages <= 1 && page === 0) return null;
  return (
    <div className="mkt-pagebar">
      <span>
        第 {page + 1} 页 / {totalPages} 页
      </span>
      <div className="mkt-pagebtns">
        <button
          type="button"
          className="ghost sm"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          ‹ 上一页
        </button>
        <button
          type="button"
          className="ghost sm"
          disabled={page >= totalPages - 1}
          onClick={() => onPage(page + 1)}
        >
          下一页 ›
        </button>
      </div>
    </div>
  );
}

/* ---------------- 已安装状态 ---------------- */

interface InstalledSnapshot {
  pkgSources: Set<string>;
  pkgPaths: Set<string>;
  skillNames: Set<string>;
  /** 已接入的 MCP 服务器（插件接入型安装的落地形态） */
  mcpServers: McpServerInfo[];
}

async function loadInstalled(): Promise<InstalledSnapshot> {
  try {
    const [r, m] = await Promise.all([
      invoke("market:list", {}) as Promise<{
        packages: InstalledPackageInfo[];
        localSkills: InstalledSkillInfo[];
      }>,
      invoke("mcp:list", {}) as Promise<{
        servers: InstalledSnapshot["mcpServers"];
      }>,
    ]);
    return {
      pkgSources: new Set(
        r.packages.map((p) =>
          p.source.replace(/^(npm:(?:@[^/]+\/)?[^@]+)@.*$/, "$1"),
        ),
      ),
      pkgPaths: new Set(r.packages.map((p) => p.installedPath ?? "")),
      skillNames: new Set(r.localSkills.map((s) => s.name)),
      mcpServers: m.servers ?? [],
    };
  } catch {
    return {
      pkgSources: new Set(),
      pkgPaths: new Set(),
      skillNames: new Set(),
      mcpServers: [],
    };
  }
}

function isCardInstalled(
  card: CatalogCard,
  kind: "plugins" | "skills",
  snap: InstalledSnapshot | null,
): boolean {
  if (!snap) return false;
  // MCP 插件：以安装时写入的服务器描述标记判定（描述 = 来自官方插件 <name>）
  if (
    card.origin === "claude" &&
    snap.mcpServers.some((s) => s.description === `来自官方插件 ${card.name}`)
  )
    return true;
  if (card.origin === "pi") {
    // npm: 源全等匹配；本地路径安装的以包名结尾匹配
    return (
      snap.pkgSources.has(`npm:${card.name}`) ||
      snap.pkgSources.has(card.name) ||
      [...snap.pkgPaths].some((p) =>
        p.replace(/\/$/, "").endsWith(`/${card.name}`),
      )
    );
  }
  if (kind === "skills") return snap.skillNames.has(card.name);
  // 插件页的 Claude 条目：包装为 claude-<name> 本地包
  return [...snap.pkgSources, ...snap.pkgPaths].some((s) =>
    s.includes(`claude-${card.name}`),
  );
}

/* ---------------- 目录页（插件/技能统一） ---------------- */

function CatalogPage({
  kind,
}: {
  kind: "plugins" | "skills";
}): React.ReactElement {
  const source = useStore((s) =>
    kind === "plugins" ? s.pluginsSource : s.skillsSource,
  );
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<CatalogCard[] | null>(null);
  const [recommendations, setRecommendations] = useState<CatalogCard[]>([]);
  const [recommendMeta, setRecommendMeta] = useState<{
    generatedAt: number;
    nextRefreshAt: number;
    note?: string;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const currentInstall = useRef<{ id: string; key: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [snap, setSnap] = useState<InstalledSnapshot | null>(null);
  const [detail, setDetail] = useState<{
    card: CatalogCard;
    content: string | null;
  } | null>(null);
  const [authSource, setAuthSource] = useState<string | null>(null);
  const version = useRef(0);
  const active = useRef(true);
  const refreshInstalled = () =>
    void loadInstalled().then((value) => {
      if (active.current) setSnap(value);
    });
  useEffect(() => {
    active.current = true;
    refreshInstalled();
    return () => {
      active.current = false;
      version.current++;
      const pending = currentInstall.current;
      if (pending)
        void invoke("market:cancelInstall", { operationId: pending.id }).catch(
          () => {},
        );
    };
  }, []);
  const makeCard = (x: {
    name: string;
    source?: string;
    origin?: "pi" | "claude";
    description?: string | null;
    downloads?: number | null;
    kind?: string;
    installable?: boolean;
    compatibility?: string;
    auth?: string;
    reasons?: string[];
  }): CatalogCard => {
    const origin = x.origin ?? (source === "claude" ? "claude" : "pi");
    const installSource =
      x.source && x.source !== "npm"
        ? x.source
        : origin === "pi"
          ? `npm:${x.name}`
          : `claude:${x.name}`;
    return {
      key: `${origin}:${x.name}`,
      source: installSource,
      origin,
      name: x.name,
      description: x.description || "暂无描述",
      downloads: x.downloads ?? null,
      meta: `${origin === "pi" ? "Pi 社区" : "Claude 官方"} · ${x.downloads != null ? `月下载 ${x.downloads.toLocaleString("zh-CN")}` : "下载量未知"}`,
      mcpPlugin: x.kind === "mcp-plugin",
      installable: x.installable !== false,
      compatibility:
        x.compatibility ??
        (x.kind === "mcp-plugin" ? "MCP 插件 · 安装即接入" : undefined),
      auth:
        x.auth || x.kind === "mcp-plugin" || /\/pi-lark(?:-cli)?$/.test(x.name)
          ? true
          : false,
      reasons: x.reasons?.filter((reason) => !reason.startsWith("月下载 ")),
      install: async (operationId) => {
        const r =
          origin === "pi"
            ? await invoke("market:installNpm", {
                spec: installSource.replace(/^npm:/, ""),
                operationId,
              })
            : await invoke("market:installClaude", {
                name: x.name,
                as: kind === "plugins" ? "package" : "skill",
                operationId,
              });
        if (!r.ok) throw new Error(r.message ?? "安装失败");
      },
    };
  };
  const load = async (q = "") => {
    const request = ++version.current;
    setSearching(true);
    setNote(null);
    try {
      const origins: Array<"pi" | "claude"> =
        source === "all" ? ["pi", "claude"] : [source];
      const results = await Promise.allSettled(
        origins.map(async (origin) => {
          const r =
            origin === "pi"
              ? await invoke("market:listPi", { query: q || undefined, kind })
              : await invoke("market:listClaude", {
                  query: q || undefined,
                  kind,
                });
          return { r, origin };
        }),
      );
      if (request !== version.current || !active.current) return;
      const successful = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      setCards(
        successful.flatMap(({ r, origin }) =>
          r.items
            .filter(
              (x) =>
                kind === "plugins" || !("kind" in x) || x.kind !== "mcp-plugin",
            )
            .map((x) => makeCard({ ...x, origin })),
        ),
      );
      const notes = successful.flatMap(({ r }) =>
        "note" in r && r.note
          ? [r.note]
          : "fallbackSource" in r && r.fallbackSource
            ? ["官方目录暂不可用，显示回退清单"]
            : [],
      );
      if (results.some((r) => r.status === "rejected"))
        notes.push(
          successful.length
            ? "部分来源加载失败，已显示可用来源，点击重新加载重试。"
            : "目录加载失败，点击重新加载重试。",
        );
      setNote(notes.join("；") || null);
    } catch (e) {
      if (request === version.current && active.current) {
        setCards([]);
        setNote(
          `目录加载失败：${e instanceof Error ? e.message : String(e)}。点击重新加载可重试。`,
        );
      }
    } finally {
      if (request === version.current && active.current) setSearching(false);
    }
  };
  useEffect(() => {
    setCards(null);
    setDetail(null);
    setQuery("");
    setRecommendations([]);
    setRecommendMeta(null);
    setNote(null);
    const generation = ++version.current;
    let cancelled = false;
    void load();
    const refresh = async () => {
      const origins: Array<"pi" | "claude"> =
        source === "all" ? ["pi", "claude"] : [source];
      const results = await Promise.allSettled(
        origins.map(async (origin) => ({
          origin,
          r: await invoke("market:recommend", { source: origin, kind }),
        })),
      );
      if (cancelled || !active.current) return;
      const ready = results.flatMap((x) =>
        x.status === "fulfilled" ? [x.value] : [],
      );
      setRecommendations(
        ready.flatMap(({ r, origin }) =>
          r.items.map((x) => makeCard({ ...x, origin })),
        ),
      );
      setRecommendMeta(
        ready.length
          ? {
              generatedAt: Math.min(...ready.map((x) => x.r.generatedAt)),
              nextRefreshAt: Math.min(...ready.map((x) => x.r.nextRefreshAt)),
              note: ready
                .map((x) => x.r.note)
                .filter(Boolean)
                .join("；"),
            }
          : {
              generatedAt: 0,
              nextRefreshAt: 0,
              note: "推荐加载失败，稍后重试",
            },
      );
    };
    refresh();
    const timer = setInterval(refresh, 3600_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (version.current >= generation) version.current++;
    };
  }, [source, kind]);
  const doInstall = async (card: CatalogCard) => {
    if (currentInstall.current) return;
    const operationId = crypto.randomUUID();
    currentInstall.current = { id: operationId, key: card.key };
    setDetail(null);
    setCancelling(false);
    setFinishing(false);
    setBusy(card.key);
    setNote(`正在安装 ${card.name}…`);
    try {
      await card.install(operationId);
      if (!active.current) return;
      setNote(`已安装 ${card.name}，新任务中生效。`);
      refreshInstalled();
      try {
        const info = await invoke("market:authInfo", {
          source: card.source ?? `${card.origin}:${card.name}`,
        });
        if (active.current && info.kind !== "none" && info.status !== "ready") {
          setDetail(null);
          setAuthSource(info.source);
        } else if (active.current && info.status === "ready" && info.message)
          setNote(`已安装 ${card.name}。${info.message}`);
      } catch {
        if (active.current)
          setNote(
            `已安装 ${card.name}；认证信息暂不可用，可通过「去认证」重试。`,
          );
      }
    } catch (e) {
      if (active.current) {
        const message = e instanceof Error ? e.message : String(e);
        setNote(message === "已取消安装" ? message : `安装失败：${message}`);
      }
    } finally {
      currentInstall.current = null;
      if (active.current) {
        setBusy(null);
        setCancelling(false);
        setFinishing(false);
      }
    }
  };
  const cancelInstall = async () => {
    const pending = currentInstall.current;
    if (!pending || cancelling) return;
    setCancelling(true);
    setNote("正在取消安装并清理临时文件…");
    try {
      const result = await invoke("market:cancelInstall", {
        operationId: pending.id,
      });
      if (
        active.current &&
        currentInstall.current?.id === pending.id &&
        !result.ok
      ) {
        setFinishing(true);
        setNote("正在完成安装，已进入提交阶段，暂时无法取消。");
      }
    } catch (e) {
      if (active.current && currentInstall.current?.id === pending.id) {
        setCancelling(false);
        setNote(
          `取消失败：${e instanceof Error ? e.message : String(e)}，可重试。`,
        );
      }
    }
  };
  const openDetail = async (card: CatalogCard) => {
    setDetail({ card, content: null });
    if (card.origin === "claude") {
      try {
        const { content } = await invoke("market:claudeDetail", {
          name: card.name,
          kind,
        });
        if (active.current)
          setDetail((d) => (d?.card.key === card.key ? { card, content } : d));
      } catch {
        if (active.current)
          setDetail((d) =>
            d?.card.key === card.key
              ? { card, content: "详情加载失败，请稍后重新打开。" }
              : d,
          );
      }
    }
  };
  const onAuth = (card: CatalogCard) => {
    setDetail(null);
    setAuthSource(card.source ?? `${card.origin}:${card.name}`);
  };
  const paged = usePaged(cards ?? []);
  const isPlugins = kind === "plugins";
  const renderCard = (card: CatalogCard) => (
    <CardView
      key={card.key}
      card={card}
      installed={isCardInstalled(card, kind, snap)}
      busy={busy === card.key}
      blocked={busy !== null}
      onInstall={doInstall}
      onOpen={openDetail}
      onAuth={onAuth}
    />
  );
  return (
    <MarketShell
      title={isPlugins ? "插件" : "技能"}
      sub={
        isPlugins
          ? "选择来源，安装工具并完成认证。"
          : "选择来源，让 Agent 掌握新的工作流程。"
      }
      actions={
        <>
          <input
            className="mkt-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void load(query)}
            placeholder={isPlugins ? "搜索插件…" : "搜索技能…"}
            aria-label={isPlugins ? "搜索插件" : "搜索技能"}
          />
          <button
            type="button"
            className="primary"
            disabled={searching}
            onClick={() => void load(query)}
          >
            {searching ? "搜索中…" : "搜索"}
          </button>
          <button
            type="button"
            className="ghost"
            title="重新加载"
            disabled={searching}
            onClick={() => void load(query)}
          >
            重新加载
          </button>
          {isPlugins ? (
            <div className="mkt-drop">
              <button
                type="button"
                className="primary dark"
                onClick={() => setAddOpen(!addOpen)}
              >
                添加 ▾
              </button>
              {addOpen ? (
                <AddLocalDropdown
                  onClose={() => setAddOpen(false)}
                  onDone={refreshInstalled}
                />
              ) : null}
            </div>
          ) : null}
        </>
      }
    >
      <div className="mkt-filter-row">
        <span className="hint">
          {source === "all"
            ? "全部来源 · Pi 社区与 Claude 官方"
            : source === "pi"
              ? "Pi 官方社区目录 · npm 发布包"
              : isPlugins
                ? "Claude 官方插件市场"
                : "Anthropic 官方技能库与插件内技能"}
        </span>
      </div>
      <div className="mkt-filter-row">
        {note ? (
          <p className="hint" role="status">
            {note}
          </p>
        ) : null}
        {busy ? (
          <button
            type="button"
            className="ghost sm"
            disabled={cancelling}
            onClick={() => void cancelInstall()}
          >
            {finishing ? "正在完成…" : cancelling ? "正在取消…" : "取消安装"}
          </button>
        ) : null}
      </div>
      <section className="mkt-section" aria-label="每周推荐">
        <div className="mkt-section-head">
          <h2>本周推荐</h2>
          <span className="hint">每周自动更新</span>
        </div>
        <p className="hint">{recommendMeta?.note ?? "正在获取推荐…"}</p>
        {recommendMeta?.generatedAt ? (
          <p className="hint">
            更新于{" "}
            {new Date(recommendMeta.generatedAt).toLocaleDateString("zh-CN")} ·
            下次更新{" "}
            {new Date(recommendMeta.nextRefreshAt).toLocaleDateString("zh-CN")}
          </p>
        ) : null}
        <div className="mkt-grid">{recommendations.map(renderCard)}</div>
      </section>
      <section className="mkt-section" aria-label="浏览目录">
        <div className="mkt-section-head">
          <h2>{isPlugins ? "浏览插件" : "浏览技能"}</h2>
          <span className="hint">
            {cards?.length ?? 0} 项{query ? ` · “${query}”` : ""}
          </span>
        </div>
        {cards === null || searching ? (
          <p className="hint pad" role="status">
            正在加载目录…
          </p>
        ) : !cards.length ? (
          <p className="hint pad">
            暂无匹配结果，可以尝试其他关键词或切换来源。
          </p>
        ) : (
          <>
            <PageBar
              page={paged.page}
              totalPages={paged.totalPages}
              onPage={paged.setPage}
            />
            <div className="mkt-grid">{paged.slice.map(renderCard)}</div>
          </>
        )}
      </section>
      {detail ? (
        <CardDetailModal
          card={detail.card}
          content={detail.content}
          installed={isCardInstalled(detail.card, kind, snap)}
          busy={busy === detail.card.key}
          onInstall={doInstall}
          onAuth={onAuth}
          onClose={() => setDetail(null)}
        />
      ) : null}
      {authSource ? (
        <PluginAuthModal
          key={authSource}
          source={authSource}
          onDone={() => {
            setAuthSource(null);
            refreshInstalled();
          }}
        />
      ) : null}
    </MarketShell>
  );
}

/** 单张目录卡（悬停交互 + 点击进详情）。 */
function CardView({
  card,
  installed,
  busy,
  blocked,
  onInstall,
  onOpen,
  onAuth,
}: {
  card: CatalogCard;
  installed: boolean;
  busy: boolean;
  blocked?: boolean;
  onInstall: (c: CatalogCard) => void;
  onOpen: (c: CatalogCard) => void;
  onAuth?: (c: CatalogCard) => void;
}): React.ReactElement {
  return (
    <div
      className="card-row mkt-card"
      role="button"
      tabIndex={0}
      onClick={() => void onOpen(card)}
      onKeyDown={(e) =>
        e.target === e.currentTarget && e.key === "Enter" && void onOpen(card)
      }
    >
      <div className="mkt-ico">
        <Icon name={card.origin === "pi" ? "plugin" : "spark"} size={23} />
      </div>
      <div className="card-main">
        <div className="card-name clamp">
          {card.name}
          {installed ? <span className="badge ok">已安装</span> : null}
        </div>
        <div className="card-meta clamp">{card.description}</div>
        {card.compatibility ? (
          <div className="mkt-cardmeta">{card.compatibility}</div>
        ) : null}
        {card.reasons?.length ? (
          <div className="mkt-cardmeta">{card.reasons.join(" · ")}</div>
        ) : null}
        <div className="mkt-cardmeta clamp">{card.meta}</div>
      </div>
      <div className="bar-actions">
        {installed ? (
          <button
            type="button"
            className="ghost sm"
            disabled={!card.auth}
            onClick={(e) => {
              e.stopPropagation();
              onAuth?.(card);
            }}
          >
            {card.auth ? "认证设置" : "已安装"}
          </button>
        ) : (
          <button
            type="button"
            className="primary sm"
            disabled={busy || blocked || card.installable === false}
            onClick={(e) => {
              e.stopPropagation();
              void onInstall(card);
            }}
          >
            {busy
              ? "安装中…"
              : card.installable === false
                ? "暂不支持"
                : "安装"}
          </button>
        )}
      </div>
      <span className="mkt-chev">›</span>
    </div>
  );
}

/** 详情弹窗：完整信息 + SKILL.md 预览（Claude 源）+ 安装。 */
function CardDetailModal({
  card,
  content,
  installed,
  busy,
  onInstall,
  onAuth,
  onClose,
}: {
  card: CatalogCard;
  content: string | null;
  installed: boolean;
  busy: boolean;
  onInstall: (c: CatalogCard) => void;
  onAuth: (c: CatalogCard) => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div
      className="modal-mask"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal anim-pop mkt-detail-modal">
        <div className="mkt-detail-head">
          <div className="mkt-ico big">
            <Icon name={card.origin === "pi" ? "plugin" : "spark"} size={23} />
          </div>
          <div className="mkt-detail-title">
            <h2>{card.name}</h2>
            <p className="hint">{card.meta}</p>
          </div>
        </div>
        <p className="mkt-detail-desc">{card.description}</p>
        {card.origin === "claude" ? (
          content ? (
            <pre className="skill-preview">{content.slice(0, 4000)}</pre>
          ) : (
            <p className="hint">正在加载技能全文…</p>
          )
        ) : null}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
          {installed ? (
            <button
              type="button"
              className="primary"
              disabled={!card.auth}
              onClick={() => onAuth(card)}
            >
              {card.auth ? "认证设置" : "已安装"}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || card.installable === false}
              onClick={() => {
                void onInstall(card);
              }}
            >
              {busy
                ? "安装中…"
                : card.installable === false
                  ? "暂不支持"
                  : "安装"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AddLocalDropdown({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}): React.ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="mkt-drop-menu add-local anim-pop">
      <p className="hint">
        安装本地 pi 包（目录含
        extensions/skills/prompts/themes）；原文件不改写。
      </p>
      <div className="provider-actions">
        <button
          type="button"
          className="primary"
          onClick={async () => {
            const { path } = await invoke("market:pickLocal", {});
            if (!path) return;
            const r = await invoke("market:installLocal", { path });
            setMessage(
              r.ok ? `已安装本地包：${path}` : `安装失败：${r.message ?? ""}`,
            );
            if (r.ok) onDone();
          }}
        >
          选择目录…
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          收起
        </button>
      </div>
      {message ? <p className="hint">{message}</p> : null}
    </div>
  );
}

/** 精选清单：插件取目录下载量 Top；无目录时静态清单；技能为常用度精选（热度序）。 */
/* ---------------- 已安装（分插件/技能，不显示目录） ---------------- */

function InstalledDetail(): React.ReactElement {
  const [state, setState] = useState<{
    packages: InstalledPackageInfo[];
    localSkills: InstalledSkillInfo[];
    localExtensions: string[];
  } | null>(null);
  const [mcpServers, setMcpServers] = useState<InstalledSnapshot["mcpServers"]>(
    [],
  );
  const [pluginAuthSource, setPluginAuthSource] = useState<string | null>(null);
  const [larkReady, setLarkReady] = useState<Record<string, boolean>>({});
  const [mcpAuth, setMcpAuth] = useState<Record<string, MarketAuthInfo>>({});
  const [message, setMessage] = useState<string | null>(null);

  const reload = () => {
    void invoke("market:list", {})
      .then((r) => {
        setState(r);
        void Promise.all(
          r.packages
            .filter((p) =>
              /^npm:@(?:amaster\.ai|tunglam|yandy0725)\/pi-lark(?:-cli)?(?:@[^/]+)?$/.test(
                p.source,
              ),
            )
            .map(async (p) => {
              try {
                const auth = await invoke("market:authInfo", {
                  source: p.source,
                });
                return [p.source, auth.status === "ready"] as const;
              } catch {
                return [p.source, false] as const;
              }
            }),
        ).then((entries) => setLarkReady(Object.fromEntries(entries)));
      })
      .catch((e) => setMessage(e instanceof Error ? e.message : String(e)));
    void invoke("mcp:list", {})
      .then((r) => {
        setMcpServers(r.servers ?? []);
        for (const server of r.servers ?? [])
          if (server.kind === "http") {
            void invoke("market:authInfo", { source: `claude:${server.name}` })
              .then((info) => {
                setMcpAuth((current) => ({ ...current, [server.name]: info }));
                if (info.status === "ready" && server.missingVars?.length)
                  void invoke("mcp:list", {})
                    .then((next) => setMcpServers(next.servers ?? []))
                    .catch(() => {});
              })
              .catch(() => {});
          }
      })
      .catch(() => setMcpServers([]));
  };
  useEffect(reload, []);

  const setVis = async (
    name: string,
    kind: "skill" | "package",
    visibility: "public" | "private",
  ) => {
    try {
      const r = await invoke("market:setVisibility", {
        name,
        kind,
        visibility,
      });
      setMessage(
        r.ok
          ? `已设为${visibility === "public" ? "公开" : "私有"}：${name}`
          : `设置失败：${r.message ?? ""}`,
      );
      reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (source: string) => {
    await invoke("market:remove", { source });
    reload();
  };

  return (
    <MarketShell
      title="已安装"
      sub="管理插件与技能。"
      actions={<span className="hint">变更即时生效</span>}
    >
      {message ? <p className="hint pad">{message}</p> : null}
      {state === null ? (
        <p className="hint pad">加载中…</p>
      ) : (
        <>
          {(state.packages.some((p) => p.core) ?? false) ? (
            <section className="mkt-section">
              <div className="mkt-section-head">
                <h2>
                  基础能力（{state.packages.filter((p) => p.core).length}）
                </h2>
                <span className="mkt-chev">›</span>
                <span className="hint">
                  赋予 harness 核心能力 · 不可移除 · 不可设为私有
                </span>
              </div>
              <div className="mkt-grid">
                {state.packages
                  .filter((p) => p.core)
                  .map((p) => (
                    <div key={p.source} className="card-row mkt-card static">
                      <div className="mkt-ico">
                        <Icon name="shield" size={20} />
                      </div>
                      <div className="card-main">
                        <div className="card-name clamp">
                          {p.source.replace(/^npm:/, "")}
                          <span className="badge ok">基础能力</span>
                        </div>
                        <div className="card-meta clamp">{p.intro ?? ""}</div>
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          ) : null}
          <section className="mkt-section">
            <div className="mkt-section-head">
              <h2>插件（{state.packages.filter((p) => !p.core).length}）</h2>
              <span className="mkt-chev">›</span>
            </div>
            <div className="mkt-grid">
              {state.packages.filter((p) => !p.core).length === 0 ? (
                <p className="hint">暂无插件。</p>
              ) : (
                state.packages
                  .filter((p) => !p.core)
                  .map((p) => (
                    <div key={p.source} className="card-row mkt-card static">
                      <div className="mkt-ico">
                        <Icon name="plugin" size={20} />
                      </div>
                      <div className="card-main">
                        <div className="card-name clamp">
                          {p.source.replace(/^npm:/, "")}
                        </div>
                      </div>
                      <div className="bar-actions">
                        {/^npm:@(?:amaster\.ai|tunglam|yandy0725)\/pi-lark(?:-cli)?(?:@[^/]+)?$/.test(
                          p.source,
                        ) ? (
                          <>
                            {larkReady[p.source] ? (
                              <span className="badge ok">已认证</span>
                            ) : null}
                            <button
                              type="button"
                              className="ghost sm"
                              onClick={() => setPluginAuthSource(p.source)}
                            >
                              {larkReady[p.source] ? "管理认证" : "去认证"}
                            </button>
                          </>
                        ) : null}
                        <VisToggle
                          name={p.source}
                          kind="package"
                          value={p.visibility ?? "public"}
                          onChange={setVis}
                        />
                        <button
                          type="button"
                          className="ghost danger-text sm"
                          onClick={() => void remove(p.source)}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  ))
              )}
            </div>
          </section>

          <section className="mkt-section">
            <div className="mkt-section-head">
              <h2>技能（{state.localSkills.length}）</h2>
              <span className="mkt-chev">›</span>
            </div>
            <div className="mkt-grid">
              {state.localSkills.length === 0 ? (
                <p className="hint">暂无技能。</p>
              ) : (
                state.localSkills.map((sk) => (
                  <div key={sk.name} className="card-row mkt-card static">
                    <div className="mkt-ico">
                      <Icon name="spark" size={19} />
                    </div>
                    <div className="card-main">
                      <div className="card-name clamp">{sk.name}</div>
                    </div>
                    <div className="bar-actions">
                      <VisToggle
                        name={sk.name}
                        kind="skill"
                        value={sk.visibility}
                        onChange={setVis}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
            <p className="hint">
              本地扩展（{state.localExtensions.length}）：
              {state.localExtensions.join("、") || "无"}（始终公开）
            </p>
          </section>

          <section className="mkt-section">
            <div className="mkt-section-head">
              <h2>MCP 服务器（{mcpServers.length}）</h2>
              <span className="mkt-chev">›</span>
              <span className="hint">
                插件接入型安装的落地形态 · 移除后重启生效
              </span>
            </div>
            <div className="mkt-grid">
              {mcpServers.length === 0 ? (
                <p className="hint">暂无接入的 MCP 服务器。</p>
              ) : (
                mcpServers.map((s) => (
                  <div key={s.name} className="card-row mkt-card static">
                    <div className="mkt-ico">
                      <Icon name="plugin" size={20} />
                    </div>
                    <div className="card-main">
                      <div className="card-name clamp">
                        {s.name}
                        <span className={`badge ${s.enabled ? "ok" : ""}`}>
                          {s.enabled ? "已启用" : "已停用"}
                        </span>
                        {mcpAuth[s.name]?.status === "ready" &&
                        mcpAuth[s.name]?.kind === "oauth" ? (
                          <span
                            className="badge ok"
                            title={mcpAuth[s.name]?.message}
                          >
                            已认证
                          </span>
                        ) : s.missingVars && s.missingVars.length > 0 ? (
                          <span className="badge warn">
                            需认证（{s.missingVars.length}）
                          </span>
                        ) : s.authVars && s.authVars.length > 0 ? (
                          <span className="badge ok">已配置</span>
                        ) : null}
                      </div>
                      <div className="card-meta clamp">
                        {s.description ?? s.url ?? s.command ?? ""}
                      </div>
                    </div>
                    <div className="bar-actions">
                      {s.kind === "http" ||
                      (s.authVars && s.authVars.length > 0) ? (
                        <button
                          type="button"
                          className="ghost sm"
                          onClick={() =>
                            setPluginAuthSource(`claude:${s.name}`)
                          }
                        >
                          认证设置
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost sm"
                        onClick={() => {
                          void invoke("mcp:setEnabled", {
                            name: s.name,
                            enabled: !s.enabled,
                          }).then(reload);
                        }}
                      >
                        {s.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        className="ghost danger-text sm"
                        onClick={() => {
                          void invoke("mcp:remove", { name: s.name }).then(
                            reload,
                          );
                        }}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
          {pluginAuthSource ? (
            <PluginAuthModal
              source={pluginAuthSource}
              onDone={() => {
                setPluginAuthSource(null);
                reload();
              }}
            />
          ) : null}
        </>
      )}
    </MarketShell>
  );
}

/** 令牌获取页映射：按变量名匹配，服务器名兜底；一键打开免去"去哪拿 key"的门槛。 */
function VisToggle({
  name,
  kind,
  value,
  onChange,
}: {
  name: string;
  kind: "skill" | "package";
  value: "public" | "private";
  onChange: (
    n: string,
    k: "skill" | "package",
    v: "public" | "private",
  ) => void;
}): React.ReactElement {
  return (
    <div
      className="vis-toggle"
      title="公开=所有角色可用；私有=仅绑定的角色可用"
    >
      <button
        type="button"
        className={`vis-btn${value === "public" ? " on" : ""}`}
        onClick={() => void onChange(name, kind, "public")}
      >
        公开
      </button>
      <button
        type="button"
        className={`vis-btn${value === "private" ? "on" : ""}`}
        onClick={() => void onChange(name, kind, "private")}
      >
        私有
      </button>
    </div>
  );
}
