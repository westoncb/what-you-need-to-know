import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { FlowProvider, useFlow } from "../src/FlowCtx";
import { useWebSocket } from "../src/useWebSocket";

function setup(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    closed = false;
    constructor(public url: string) { sockets.push(this); }
    close() { this.closed = true; this.onclose?.(); }
    message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    WebSocket: FakeSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  let mounted = true;
  const unmount = () => { if (mounted) { act(() => root.unmount()); mounted = false; } };
  t.after(() => {
    unmount();
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { dom, root, sockets, unmount };
}

test("observer snapshots update the UI without replacing the socket", t => {
  const { root, dom, sockets } = setup(t);
  function Board() {
    const { stages, onEvent } = useFlow();
    useWebSocket("ws://127.0.0.1:4000", onEvent);
    return <div>{stages.size}</div>;
  }
  act(() => root.render(<FlowProvider><Board /></FlowProvider>));
  assert.equal(sockets.length, 1);
  act(() => sockets[0].message({ t: "snapshot", stages: { first: {} } }));
  assert.equal(dom.window.document.getElementById("root")!.textContent, "1");
  act(() => sockets[0].message({ t: "snapshot", stages: { first: {}, second: {} } }));
  assert.equal(dom.window.document.getElementById("root")!.textContent, "2");
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, false);
});

test("changing a message callback uses the latest callback on the same connection", t => {
  const { root, sockets } = setup(t);
  const received: string[] = [];
  function Listener({ label }: { label: string }) {
    useWebSocket("ws://127.0.0.1:4000", () => received.push(label));
    return null;
  }
  act(() => root.render(<Listener label="first" />));
  sockets[0].message({});
  act(() => root.render(<Listener label="second" />));
  sockets[0].message({});
  assert.deepEqual(received, ["first", "second"]);
  assert.equal(sockets.length, 1);
});

test("visibility resumes one connection and cancels the old reconnect timer", t => {
  const { root, sockets, dom, unmount } = setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hidden = false;
  Object.defineProperty(dom.window.document, "hidden", { get: () => hidden, configurable: true });
  function Listener() { useWebSocket("ws://127.0.0.1:4000", () => {}); return null; }
  act(() => root.render(<Listener />));
  sockets[0].close();
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 2);

  hidden = true;
  sockets[1].close();
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 2);
  hidden = false;
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(sockets.length, 3);

  sockets[2].close();
  unmount();
  t.mock.timers.tick(60_000);
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(sockets.length, 3);
});

test("reconnect attempts respect the retry limit", t => {
  const { root, sockets } = setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  function Listener() { useWebSocket("ws://127.0.0.1:4000", () => {}, { maxRetries: 1 }); return null; }
  act(() => root.render(<Listener />));
  sockets[0].close();
  t.mock.timers.tick(2000);
  assert.equal(sockets.length, 2);
  sockets[1].close();
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 2);
});
