/**
 * The in-app update check. Tauri's updater reads a signed manifest from the endpoint in
 * tauri.conf.json, compares its version against the running build, and hands back the
 * release if there is a newer one.
 *
 * Nothing here is taken on trust: the download is verified against the public key compiled
 * into the app, so a manifest that has been tampered with installs nothing. A check that
 * finds nothing, or that cannot reach the network, is not something to interrupt the app
 * with — which is why every failure is returned as a value rather than thrown.
 */

import { check } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "error"; message: string };

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Asks the endpoint whether a newer release exists. Never throws. */
export async function checkForUpdate(): Promise<UpdateState> {
  try {
    const found = await check();
    if (!found) return { kind: "current" };
    return { kind: "available", version: found.version, notes: found.body ?? "" };
  } catch (error) {
    return { kind: "error", message: reason(error) };
  }
}

/**
 * Downloads, verifies and installs the newer release. Reports progress as a percentage, or
 * null when the server did not say how large the download is.
 */
export async function installUpdate(onProgress: (percent: number | null) => void): Promise<boolean> {
  const found = await check();
  if (!found) return false;
  let total = 0;
  let received = 0;
  await found.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress(0);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress(total ? Math.round((received / total) * 100) : null);
    } else {
      onProgress(100);
    }
  });
  return true;
}
