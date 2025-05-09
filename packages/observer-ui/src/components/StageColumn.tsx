import React, { useEffect, useState } from "react";
import { CallModal } from "./CallModal.jsx";
import type { CallInfo, StageInfo } from "@wyntn/common/src/index.js";


export function CallCard({ call }: { call: CallInfo }) {
  const [open, setOpen] = React.useState(false);
  const color =
    call.state === "run"   ? "#888" :
    call.state === "done"  ? "#4a4" :
    "#d44";
  return (
    <>
      <div
        onClick={() => setOpen(true)}
        style={{
          margin: 2, padding: 4, background: color,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          cursor: "pointer"
        }}>
        {JSON.stringify(call.input)?.slice(0, 60)}
      </div>
      {open && <CallModal call={call} onClose={() => setOpen(false)} />}
    </>
  );
}

export function StageColumn({ stage }: { stage: StageInfo }) {
  const calls = [...stage.calls.values()].sort((a, b) => a.idx - b.idx);
  return (
    <div style={{ width: 280 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {stage.name} · {stage.cfg.model ?? ""}<br/>
        <small>{stage.totals?.in ?? 0} in / {stage.calls.size} shown</small>
      </div>
      <div style={{ maxHeight: 600, overflowY: "auto", border:"1px solid #eee" }}>
        {calls.map(c => <CallCard key={c.id} call={c} />)}
      </div>
    </div>
  );
}
