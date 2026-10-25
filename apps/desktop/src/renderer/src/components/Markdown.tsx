import { useEffect, useRef, useState } from "react";
import { invoke } from "../api.js";
import Icon from "./Icon.js";
export function CopyButton({
  getText,
  label = "复制",
}: {
  getText: () => string;
  label?: string;
}): React.ReactElement {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="msg-action"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setDone(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
      {done ? "已复制" : label}
    </button>
  );
}
function Inline({ text }: { text: string }): React.ReactElement {
  const parts = text.split(
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https:\/\/[^\s)]+\))/g,
  );
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`"))
          return <code key={i}>{part.slice(1, -1)}</code>;
        if (part.startsWith("**"))
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        const link = part.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/);
        if (link)
          return (
            <button
              key={i}
              type="button"
              className="markdown-link"
              onClick={() =>
                void invoke("sys:openExternal", { url: link[2]! }).catch(
                  () => {},
                )
              }
            >
              {link[1]}
            </button>
          );
        return part;
      })}
    </>
  );
}
function Code({
  text,
  language,
}: {
  text: string;
  language: string;
}): React.ReactElement {
  return (
    <div className="code-section">
      <div className="code-toolbar">
        <span>{language || "代码"}</span>
        <CopyButton label="复制代码" getText={() => text} />
      </div>
      <pre className="code-block">
        <code>{text}</code>
      </pre>
    </div>
  );
}
function Blocks({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n"),
    out: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const content = <Inline text={heading[2]!} />;
      out.push(
        heading[1]!.length === 1 ? (
          <h2 key={i}>{content}</h2>
        ) : heading[1]!.length === 2 ? (
          <h3 key={i}>{content}</h3>
        ) : (
          <h4 key={i}>{content}</h4>
        ),
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={i} />);
      i++;
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const start = i;
      const row = (s: string) =>
        s
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const headers = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|"))
        rows.push(row(lines[i++]!));
      out.push(
        <div className="markdown-table" key={start}>
          <table>
            <thead>
              <tr>
                {headers.map((c, j) => (
                  <th key={j}>
                    <Inline text={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>
                      <Inline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const start = i,
        ordered = /^\s*\d+\./.test(line);
      const rows: string[] = [];
      while (i < lines.length && /^\s*(?:[-*+] |\d+\. )/.test(lines[i]!))
        rows.push(lines[i++]!.replace(/^\s*(?:[-*+] |\d+\. )/, ""));
      const items = rows.map((r, j) => (
        <li key={j}>
          <Inline text={r} />
        </li>
      ));
      out.push(
        ordered ? <ol key={start}>{items}</ol> : <ul key={start}>{items}</ul>,
      );
      continue;
    }
    if (line.startsWith("> ")) {
      const start = i;
      const parts: string[] = [];
      while (lines[i]?.startsWith("> ")) parts.push(lines[i++]!.slice(2));
      out.push(
        <blockquote key={start}>
          <Inline text={parts.join("\n")} />
        </blockquote>,
      );
      continue;
    }
    const start = i,
      paragraph = [lines[i++]!];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|> |\s*(?:[-*+] |\d+\. ))/.test(lines[i]!)
    )
      paragraph.push(lines[i++]!);
    out.push(
      <p key={start}>
        <Inline text={paragraph.join("\n")} />
      </p>,
    );
  }
  return <>{out}</>;
}
export function Markdownish({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <Blocks key={i} text={part} />;
        const match = part.match(/^([^\n]*)\n/);
        return (
          <Code
            key={i}
            language={match?.[1]?.trim() ?? ""}
            text={match ? part.slice(match[0].length).replace(/\n$/, "") : part}
          />
        );
      })}
    </>
  );
}
