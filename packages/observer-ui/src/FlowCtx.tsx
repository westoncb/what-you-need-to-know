import React, { createContext, useContext, useState } from "react";
import type { FlowEvent, StageInfo } from "@wyntn/common"; // adjust import to your path

/* ------------------------------------------------------------------
   Context API
--------------------------------------------------------------------*/
interface FlowContextValue {
  /** Latest snapshot – keyed by stage id */
  stages : Map<string, StageInfo>;
  /** Callback that the WebSocket passes raw events into. */
  onEvent: (evt: FlowEvent) => void;
}

const FlowCtx = createContext<FlowContextValue | null>(null);
export function useFlow() {
  const ctx = useContext(FlowCtx);
  if (!ctx) throw new Error("useFlow must be used inside <FlowProvider>");
  return ctx;
}

/* ------------------------------------------------------------------
   Provider – holds snapshot state & exposes onEvent handler
--------------------------------------------------------------------*/
export function FlowProvider({ children }:{ children: React.ReactNode }) {
  const [stages, setStages] = useState<Map<string, StageInfo>>(new Map());

  /** WebSocket → observer events funnel into here. */
  function onEvent(evt: FlowEvent) {
    if (evt.t !== "snapshot") return;          // we ignore everything else
    // Replace the map wholesale to keep state immutable
    setStages(new Map(Object.entries(evt.stages)));
  }

  return (
    <FlowCtx.Provider value={{ stages, onEvent }}>
      {children}
    </FlowCtx.Provider>
  );
}
