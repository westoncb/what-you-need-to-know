import React, { useEffect, useState } from "react";
import StageTable from "./components/StageTable.js";

type Stage = {
  name: string;
  status: "idle" | "running" | "done" | "error";
  totals: { in: number; out: number; err: number };
};

export default function App() {
  const [stages, setStages] = useState<Record<string, Stage>>({});

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:4000");
    ws.onmessage = (ev) => {
      const evt = JSON.parse(ev.data);
      if (evt.t === "snapshot") {
        setStages(evt.stages);
      }
    };
    return () => ws.close();
  }, []);

  return (
    <div>
      <h1 style={{ margin: "0.5rem 1rem" }}>Flow Observer</h1>
      <StageTable stages={stages} />
    </div>
  );
}
