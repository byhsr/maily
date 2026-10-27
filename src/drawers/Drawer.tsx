import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

const TITLES: Record<string, string> = {
  campaign: "Campaign & sequence editor",
  template: "Template editor",
  settings: "Settings",
  agent: "Run an agent",
  lead: "Lead details",
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
        className={`drawer ${kind === "campaign" || kind === "template" ? "drawerwide" : ""}`}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 300 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <label>{kind.toUpperCase()}</label>
            <h2>{TITLES[kind]}</h2>
          </div>
          <button className="round" onClick={close}>
            <X />
          </button>
        </header>
        {children}
      </motion.aside>
    </motion.div>
  );
}
