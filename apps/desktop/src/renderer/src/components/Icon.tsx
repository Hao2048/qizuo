import type { SVGProps } from "react";
const paths = {
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chat: <path d="M5 5h14v11H9l-4 4V5Z" />,
  folder: <path d="M3 7h7l2-3h8v15H3V7Z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16M5.5 8h1M5.5 12h1" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m3 9v-2a5 5 0 0 0-3-4" />
    </>
  ),
  memory: (<><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>),
  plugin: (
    <>
      <path d="M8 3v4m8-4v4M6 7h12v5a6 6 0 0 1-12 0V7Zm6 11v4" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="2.5" />
      <circle cx="15" cy="17" r="2.5" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6m-6 4h6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m4 18 5-5 3 3 4-6 4 7" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="5" r="2" />
      <circle cx="17" cy="7" r="2" />
      <circle cx="7" cy="19" r="2" />
      <path d="M7 7v10m0-4h4a6 6 0 0 0 6-4" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4v16h16M8 15v-4m4 4V7m4 8v-6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 15 6 5h12l3 10v5H3v-5Z" />
      <path d="M3 15h5l2 3h4l2-3h5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10h.01" />
    </>
  ),
  command: (
    <>
      <path d="M8 8h8v8H8z" />
      <path d="M8 8H5a3 3 0 1 1 3-3v3Zm8 0V5a3 3 0 1 1 3 3h-3Zm0 8h3a3 3 0 1 1-3 3v-3Zm-8 0v3a3 3 0 1 1-3-3h3Z" />
    </>
  ),
  bolt: <path d="m13 2-8 12h6l-1 8 9-13h-6l0-7Z" />,
  trash: (
    <>
      <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
} satisfies Record<string, React.ReactNode>;
export type IconName = keyof typeof paths;
export default function Icon({
  name,
  size = 18,
  ...props
}: {
  name: IconName;
  size?: number;
} & SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
