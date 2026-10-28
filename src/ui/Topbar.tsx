import { Menu, Search } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useNav } from "../app/nav";

type TopbarProps = {
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  status?: ReactNode;
  action?: ReactNode;
};

export function Topbar({ search, status, action }: TopbarProps) {
  const { mobile, openNav } = useNav();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="topbar">
      {mobile && (
        <button className="navopen" onClick={openNav} aria-label="Open navigation">
          <Menu />
        </button>
      )}
      {search && (
        <label className="search">
          <Search />
          <input
            ref={input}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? "Search..."}
          />
          <kbd>Ctrl K</kbd>
        </label>
      )}
      <div className="topbar-right">
        {status && <span className="quota">{status}</span>}
        {action}
      </div>
    </div>
  );
}
