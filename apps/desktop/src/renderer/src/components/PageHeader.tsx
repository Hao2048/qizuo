import type { ReactNode } from "react";

/** Shared page hierarchy; content and commands remain owned by each feature. */
export default function PageHeader({
  section,
  title,
  actions,
  tabs,
  value,
  onTab,
}: {
  section: string;
  title: string;
  actions?: ReactNode;
  tabs?: Array<{ id: string; label: string }>;
  value?: string;
  onTab?: (id: string) => void;
}) {
  return (
    <header className="page-header">
      <div className="page-breadcrumb">
        {section}
        <span>/</span>
        <span className="clamp">{title}</span>
      </div>
      <div className="page-title-row">
        <h1>{title}</h1>
        <div className="bar-actions">{actions}</div>
      </div>
      {tabs && (
        <nav className="page-tabs" aria-label={`${section}视图`}>
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={value === tab.id ? "selected" : ""}
              aria-current={value === tab.id ? "page" : undefined}
              onClick={() => onTab?.(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}
