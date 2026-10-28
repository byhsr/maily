import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

const TITLES: Record<string, string> = {
  template: "Template",
  settings: "Settings",
  agent: "Agent",
  lead: "Lead",
};

type DrawerProps = {
  kind: string;
  close: () => void;
  children?: ReactNode;
};

export function Drawer({ kind, close, children }: DrawerProps) {
  return (
    <motion.div className="veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={close}>
      <motion.aside
        className={`drawer ${kind === "template" ? "drawerwide" : ""}`}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 300 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{TITLES[kind]}</h2>
          <button className="round" onClick={close} aria-label="Close">
            <X />
          </button>
        </header>
        {children}
      </motion.aside>
    </motion.div>
  );
}
