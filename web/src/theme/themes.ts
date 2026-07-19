export interface ThemeMeta {
  id: string;
  name: string;
  description: string;
  /** preview swatches for the theme picker: [bg, surface, accent, text] */
  swatches: [string, string, string, string];
}

/** Adding a theme = one CSS file (scoped to [data-theme="<id>"]) + an entry here. */
export const themes: ThemeMeta[] = [
  {
    id: "dockyard",
    name: "Dockyard",
    description: "Working harbor at night: ink water, brass lamps, buoy flare.",
    swatches: ["#06111a", "#12263a", "#f0b64a", "#edf6fb"],
  },
  {
    id: "slate",
    name: "Signal Room",
    description: "CRT glass, chartreuse commands, quiet command-center grid.",
    swatches: ["#090d0b", "#111a16", "#b7f06a", "#e7efe2"],
  },
  {
    id: "ledger",
    name: "Ledger",
    description: "Sunlit manifests, red pencil marks, navy ink and paper grain.",
    swatches: ["#f3ead8", "#fff8e8", "#c64034", "#1b2633"],
  },
  {
    id: "darkroom",
    name: "Darkroom",
    description: "Safelight red, photographic paper and silver-gelatin shadows.",
    swatches: ["#0b0809", "#191315", "#e45b47", "#eee5dc"],
  },
  {
    id: "porcelain",
    name: "Porcelain",
    description: "Cobalt brushwork, rice paper and a single vermilion seal.",
    swatches: ["#e8e6dd", "#f8f6ed", "#174b78", "#172331"],
  },
  {
    id: "field-station",
    name: "Field Station",
    description: "Lichen canvas, surveyor orange and sun-faded field notes.",
    swatches: ["#252b21", "#353d2d", "#e07a3f", "#f0ead5"],
  },
  {
    id: "poolside",
    name: "Poolside",
    description: "Sun-bleached terrazzo, diving-board teal and cabana coral.",
    swatches: ["#ded9c8", "#f6f0dc", "#087f7b", "#263235"],
  },
  {
    id: "night-orchard",
    name: "Night Orchard",
    description: "Plum-black foliage, pear flesh and engraved brass markers.",
    swatches: ["#110f13", "#211b22", "#b8c66a", "#eee6da"],
  },
];

export function applyTheme(id: string): void {
  const valid = themes.some((t) => t.id === id) ? id : "dockyard";
  document.documentElement.dataset.theme = valid;
}
