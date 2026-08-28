"use client";

import { useEffect } from "react";
import { decideChunkLoadRecovery } from "./chunk-load-crash";
import { installReloadOnce } from "./client-self-heal";

/**
 * Reloads the client once when a JavaScript chunk fails to load and leaves the
 * member on a dead page. See `chunk-load-crash.ts` for the diagnosis and
 * `client-self-heal.ts` for the reload mechanism.
 *
 * Watches promise rejections as well as thrown errors: a dropped dynamic import
 * rejects rather than throwing.
 *
 * Renders nothing; mounted from the root layout so it covers public routes too,
 * including `/login`, where we saw the failure.
 */
export function ChunkLoadRecovery() {
  useEffect(() => {
    installReloadOnce({
      decide: decideChunkLoadRecovery,
      storageKey: "haven:chunk-load-recovered",
      recoveredEvent: "client_chunk_load_recovered",
      watchRejections: true,
    });
  }, []);
  return null;
}
