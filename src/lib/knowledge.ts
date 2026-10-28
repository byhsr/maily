import type { KnowledgeCategory } from "./types";

/** Category list and presentation, mirroring KNOWLEDGE_CATEGORIES in main.rs. */
export const KNOWLEDGE_CATEGORIES: {
  id: KnowledgeCategory;
  label: string;
  singular: string;
  tint: string;
  hint: string;
}[] = [
  { id: "offer", label: "Offers", singular: "Offer", tint: "mint", hint: "What you sell, to whom, and the outcome it produces." },
  { id: "icp", label: "ICPs", singular: "ICP", tint: "blue", hint: "Who the offer is for: size, role, industry, signals." },
  { id: "style", label: "Style", singular: "Style", tint: "lilac", hint: "Voice, tone and sample writing the drafter should imitate." },
  { id: "proof", label: "Proof", singular: "Proof", tint: "peach", hint: "Case studies, numbers and references that are safe to cite." },
  { id: "objection", label: "Objections", singular: "Objection", tint: "blue", hint: "Common pushback and how you answer it." },
  { id: "product", label: "Products", singular: "Product", tint: "lilac", hint: "Product detail: features, positioning, pricing." },
  { id: "other", label: "Other", singular: "Note", tint: "peach", hint: "Anything else the models should know." },
];

export function categoryMeta(category: string) {
  return KNOWLEDGE_CATEGORIES.find((entry) => entry.id === category) ?? KNOWLEDGE_CATEGORIES[KNOWLEDGE_CATEGORIES.length - 1];
}
