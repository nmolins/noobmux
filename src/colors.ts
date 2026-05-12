export interface Swatch {
  id: string;
  label: string;
  hex: string;
}

export const PALETTE: Swatch[] = [
  { id: "none", label: "Aucune", hex: "" },
  { id: "red", label: "Rouge", hex: "#f7768e" },
  { id: "orange", label: "Orange", hex: "#ff9e64" },
  { id: "yellow", label: "Jaune", hex: "#e0af68" },
  { id: "green", label: "Vert", hex: "#9ece6a" },
  { id: "teal", label: "Teal", hex: "#73daca" },
  { id: "blue", label: "Bleu", hex: "#7aa2f7" },
  { id: "purple", label: "Violet", hex: "#bb9af7" },
  { id: "pink", label: "Rose", hex: "#ff79c6" },
];
