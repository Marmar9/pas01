export type EventTheme = {
  from: string;
  to: string;
  accent: string;
  label: string;
};

const THEMES: EventTheme[] = [
  {
    from: "#3813C2",
    to: "#E50F88",
    accent: "#FF7AC1",
    label: "Nocna premiera",
  },
  { from: "#0B0713", to: "#3813C2", accent: "#7C5CFF", label: "Klasyk kina" },
  {
    from: "#7A0F52",
    to: "#1B0A3A",
    accent: "#E50F88",
    label: "Nowe horyzonty",
  },
];

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

export function eventTheme(id: string): EventTheme {
  const theme = THEMES[hashString(id) % THEMES.length];
  return theme ?? THEMES[0];
}
