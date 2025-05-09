import { useWebSocket } from "./useWebSocket.jsx";
import { useFlow } from "./FlowCtx.jsx";
import { StageBoard } from "./components/StageBoard.jsx";

export default function App() {
  const { onEvent } = useFlow();

  useWebSocket("ws://localhost:4000", onEvent, { maxRetries: 100 });

  return (
    <div>
      <StageBoard />
    </div>
  );
}
