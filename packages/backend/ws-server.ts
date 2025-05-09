import { WebSocketServer } from "ws";
import { FlowEvent } from "@wyntn/common/src/t-flow/flow-observer";

export function startWsServer(port = 4000) {
  const wss = new WebSocketServer({ port });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  return (evt: FlowEvent) => {
    const msg = JSON.stringify(evt);
    for (const ws of clients) ws.readyState === ws.OPEN && ws.send(msg);
  };
}
