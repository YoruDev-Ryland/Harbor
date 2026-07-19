import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Anchor,
  BookOpen,
  Box,
  Camera,
  Clapperboard,
  Cloud,
  Database,
  Download,
  Film,
  Gamepad2,
  Globe,
  HardDrive,
  Home,
  Music,
  Newspaper,
  Play,
  Rss,
  Search,
  Server,
  Shield,
  Tv,
  Wifi,
} from "lucide-react";

/** Curated icon set for berths — pick by name in settings. */
export const tabIcons: Record<string, LucideIcon> = {
  globe: Globe,
  tv: Tv,
  film: Film,
  clapperboard: Clapperboard,
  music: Music,
  download: Download,
  server: Server,
  "hard-drive": HardDrive,
  database: Database,
  cloud: Cloud,
  shield: Shield,
  activity: Activity,
  play: Play,
  rss: Rss,
  search: Search,
  book: BookOpen,
  camera: Camera,
  gamepad: Gamepad2,
  news: Newspaper,
  box: Box,
  home: Home,
  anchor: Anchor,
  wifi: Wifi,
};

export function TabIcon({ name, size = 17 }: { name: string; size?: number }) {
  const Cmp = tabIcons[name] ?? Globe;
  return <Cmp size={size} className="nav-icon" aria-hidden />;
}

/** Harbor brand mark: an anchor rendered as a single flowing stroke. */
export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden>
      <circle cx="16" cy="7" r="3" stroke="currentColor" strokeWidth="2.2" />
      <path d="M16 10v16M9.5 14h13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path
        d="M5 19c1 5.5 5.5 9 11 9s10-3.5 11-9"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M5 19l-1.8 3.2M5 19l3.6.9M27 19l1.8 3.2M27 19l-3.6.9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
