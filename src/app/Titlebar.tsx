import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from "lucide-react";

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  const run = (action: () => Promise<unknown>) => {
    if (isTauri()) action().catch(() => {});
  };

  return (
    <div className="wincontrols">
      <button className="winbtn" title="Minimize" aria-label="Minimize" onClick={() => run(() => getCurrentWindow().minimize())}>
        <Minus />
      </button>
      <button
        className="winbtn"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => run(() => getCurrentWindow().toggleMaximize())}
      >
        {maximized ? <Copy /> : <Square />}
      </button>
      <button className="winbtn close" title="Close" aria-label="Close" onClick={() => run(() => getCurrentWindow().close())}>
        <X />
      </button>
    </div>
  );
}

type TitlebarProps = {
  collapsed: boolean;
  onToggle: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
};

/**
 * The frameless window's 36px strip. Transparent — nothing but the sidebar
 * toggle, the history buttons, the drag region and the window controls. The
 * wordmark is gone; the app's identity lives in the sidebar's workspace switcher.
 */
export function Titlebar({ collapsed, onToggle, onBack, onForward, canBack, canForward }: TitlebarProps) {
  return (
    <header className="titlebar">
      <button
        className="titlebar-toggle"
        onClick={onToggle}
        title={collapsed ? "Open sidebar (Ctrl+B)" : "Close sidebar (Ctrl+B)"}
        aria-label={collapsed ? "Open sidebar" : "Close sidebar"}
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </button>
      {/* History, not hierarchy: disabled at either end of the trail rather than hidden,
          so the strip does not shift under the pointer as you move through it. */}
      <div className="titlebar-nav">
        <button onClick={onBack} disabled={!canBack} title="Back (Alt+←)" aria-label="Back">
          <ArrowLeft />
        </button>
        <button onClick={onForward} disabled={!canForward} title="Forward (Alt+→)" aria-label="Forward">
          <ArrowRight />
        </button>
      </div>
      <div className="drag" data-tauri-drag-region />
      <WindowControls />
    </header>
  );
}
