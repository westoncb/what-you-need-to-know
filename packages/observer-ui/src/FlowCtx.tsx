import React, { createContext, useContext, useRef, useState } from "react";
import type {
  FlowEvent,
  StageInfo,
} from "@wyntn/common";

/* ------------------------------------------------------------------ */
/* Context helpers                                                    */
/* ------------------------------------------------------------------ */
interface FlowContextValue {
  stages: Map<string, StageInfo>;
  onEvent: (e: FlowEvent) => void;
}

const FlowCtx = createContext<FlowContextValue | null>(null);
export function useFlow() {
  const ctx = useContext(FlowCtx);
  if (!ctx) throw new Error("useFlow must be used within <FlowProvider>");
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Provider                                                           */
/* ------------------------------------------------------------------ */
export function FlowProvider({ children }: { children: React.ReactNode }) {
  const [stages, setStages] = useState<Map<string, StageInfo>>(new Map());

  // maps callId -> stageId so call_end can locate its stage
  const callToStage = useRef(new Map<string, string>()).current;

  function onEvent(evt: FlowEvent) {
    setStages(prev => {
      // Create a new Map to maintain immutability
      const draft = new Map(prev);

      switch (evt.t) {
        case "flow_end":
          callToStage.clear();
          return new Map(); // Return empty map for reset

        case "stage_create":
          draft.set(evt.id, { ...evt, calls: [] });
          return draft;

        case "call_start": {
          const stage = draft.get(evt.stage);
          if (stage) {
            // Create a new stage object with updated calls array
            draft.set(evt.stage, {
              ...stage,
              calls: [...stage.calls, { ...evt, state: "run" }]
            });
            callToStage.set(evt.id, evt.stage);
          }
          return draft;
        }

        case "call_end": {
          const stageId = callToStage.get(evt.id);
          if (!stageId) return draft;

          const stage = draft.get(stageId);
          if (!stage) return draft;

          const callIndex = stage.calls.findIndex(c => c.id === evt.id);
          if (callIndex !== -1) {
            // Create a new calls array with the updated call
            const newCalls = [...stage.calls];
            newCalls[callIndex] = {
              ...newCalls[callIndex],
              output: evt.output,
              error: evt.error,
              latency: evt.latency,
              state: evt.ok ? "done" : "error"
            };

            // Update the stage with the new calls array
            draft.set(stageId, {
              ...stage,
              calls: newCalls
            });
          }
          return draft;
        }

        case "snapshot": {
          Object.entries(evt.stages).forEach(([id, snap]) => {
            const existingStage = draft.get(id);
            draft.set(id, {
              ...(existingStage || { ...snap, calls: [] }),
              ...snap
            });
          });
          return draft;
        }

        default:
          return prev; // Return previous state for unhandled event types
      }
    });
  }

  return <FlowCtx.Provider value={{ stages, onEvent }}>{children}</FlowCtx.Provider>;
}
