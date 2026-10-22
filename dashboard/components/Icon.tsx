/** Small stroke icons (24×24). Decorative: always aria-hidden, the text next to them carries the meaning. */
const PATHS: Record<string, string> = {
  megaphone: "M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Zm12-3a5 5 0 0 1 0 8M18 5a9 9 0 0 1 0 14",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  inbox: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
  phone: "M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2Z",
  magnet: "M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3ZM6 7h4M14 7h4",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z",
  compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm3.5 5.5-2 5-5 2 2-5Z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  dollar: "M12 3v18M16 7.5C16 5.6 14.2 5 12 5s-4 .9-4 3 2 2.6 4 3 4 1 4 3.2-1.8 2.8-4 2.8-4-.8-4-2.8",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  check: "M5 12.5l4.5 4.5L19 7",
  x: "M6 6l12 12M18 6 6 18",
  pencil: "M4 20h4L19 9l-4-4L4 16Zm9-13 4 4",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  post: "M4 4h16v16H4zM4 15l4-4 4 4 3-3 5 5M15 8.5h.01",
  chat: "M4 5h16v11H9l-5 4Z",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6",
  play: "M8 5v14l11-7Z",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v5m0-8h.01",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4Z",
  team: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20a6 6 0 0 1 12 0M12 20a6 6 0 0 1 10 0",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  minus: "M5 12h14",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4Zm4 4h4",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0Zm6 9v4",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7M18 14a6 6 0 0 1 4 6",
  printer: "M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7Z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

export const AGENT_ICON: Record<string, IconName> = {
  "growth-director": "compass",
  triage: "inbox",
  "ad-writer": "megaphone",
  "media-producer": "film",
  "lead-qualifier": "magnet",
  "voice-dispatcher": "phone",
  analyst: "chart",
  "reputation-guard": "shield",
  owner: "user",
  system: "gear",
};

export const KIND_ICON: Record<string, IconName> = {
  ad_variant: "megaphone",
  organic_post: "post",
  budget_reallocation: "sliders",
  reputation_reply: "chat",
  ad_launch: "dollar",
  booking: "calendar",
};
