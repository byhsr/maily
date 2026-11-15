import { Menu, Search } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useNav } from "../app/nav";

type PageHeaderProps = {
  /** A node, so a detail page can hand in its own inline-editable title. */
  title: ReactNode;
  /** Muted 12px text next to the title (counts, "0 sent", …). */
  status?: ReactNode;
  /** Rendered inline in the tools group, only where the page has a query state. */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    /** A keyboard hint drawn at the end of the field, e.g. "/" or "⌘K". */
    hint?: string;
  };
  /** A page that owns its own scrolling drops the header's margin and rules its own
   *  bottom edge, so the panes below start flush against it. */
  flush?: boolean;
  /** Page-level controls: buttons, selects, the per-list name field. */
  tools?: ReactNode;
  /** A segmented control (tabs / ranges), kept separate so it sits before the action. */
  segmented?: ReactNode;
  /** A segmented control given its own row under the title, for a page whose tabs are
   *  navigation rather than a filter. The header then rules its own bottom edge. */
  tabs?: ReactNode;
  /** The single primary action for this screen. */
  action?: ReactNode;
  /** A back link rendered above the title (detail pages). */
  back?: ReactNode;
};

/**
 * One compact row per page: title on the left, controls on the right. This
 * replaces the old standalone top bar — there is no second header row.
 */
export function PageHeader({ title, status, search, tools, segmented, tabs, action, back, flush }: PageHeaderProps) {
  const { mobile, openNav } = useNav();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!search) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      } else if (e.key === "/" && !typing) {
        // The hint chip promises this, so it has to work.
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search]);

  return (
    <header className={["pagehead", flush ? "flush" : "", tabs ? "tabbed" : ""].filter(Boolean).join(" ")}>
      {mobile && (
        <button className="navopen" onClick={openNav} aria-label="Open navigation">
          <Menu />
        </button>
      )}

      <div className="pagehead-main">
        {back}
        <div className="pagehead-titles">
          <h1 className="pagetitle">{title}</h1>
          {status && <span className="pagestatus">{status}</span>}
        </div>
      </div>

      <div className="pagehead-tools">
        {search && (
          <label className="search">
            <Search />
            <input
              ref={input}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? "Search..."}
            />
            {search.hint && <kbd className="searchhint">{search.hint}</kbd>}
          </label>
        )}
        {tools}
        {segmented}
        {action}
      </div>

      {tabs && <div className="pagehead-tabs">{tabs}</div>}
    </header>
  );
}
