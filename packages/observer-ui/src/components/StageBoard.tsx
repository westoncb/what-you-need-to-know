import { useFlow } from "../FlowCtx.jsx";
import { StageColumn } from "./StageColumn.jsx";

export function StageBoard() {
  const { stages } = useFlow();
  const cols = [...stages.values()].sort((a, b) => a.id?.localeCompare(b.id));
  return (
    <div style={{ display: "flex", gap: "1rem", padding: "1rem" }}>
      {cols.map(s => <StageColumn key={s.id} stage={s} />)}
    </div>
  );
}
