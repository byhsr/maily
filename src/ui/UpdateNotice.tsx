import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { checkForUpdate, installUpdate, type UpdateState } from "../lib/updates";

/**
 * Checks for a new release once when the app opens, and says so if there is one. It is the
 * only chrome the updater ever shows: a check that finds nothing, or cannot reach the
 * network, renders nothing at all, because this is a mail tool and not an updater.
 */
export function UpdateNotice() {
  const [state, setState] = useState<UpdateState>({ kind: "checking" });
  const [percent, setPercent] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    // The check is fire-and-forget: nothing waits on it, and a failure leaves the app alone.
    let live = true;
    checkForUpdate().then((found) => {
      if (live) setState(found);
    });
    return () => {
      live = false;
    };
  }, []);

  if (state.kind !== "available") return null;

  const install = async () => {
    setInstalling(true);
    try {
      const done = await installUpdate(setPercent);
      // The new build cannot take over while this one holds the process.
      if (done) await relaunch();
    } catch {
      // A failed install leaves the old build running and working, so there is nothing to
      // report but the fact that it did not happen.
      setInstalling(false);
      setPercent(null);
    }
  };

  return (
    <div className="updatenotice">
      <span>
        Maily <b>{state.version}</b> is available
      </span>
      <button type="button" className="link" disabled={installing} onClick={install}>
        {installing ? (percent === null ? "Downloading…" : `${percent}%`) : "Install and restart"}
      </button>
    </div>
  );
}
