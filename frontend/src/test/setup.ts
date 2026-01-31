import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// Radix UI components rely on Pointer Events APIs that jsdom doesn't fully implement.
// Polyfill minimal stubs to prevent test crashes (e.g. Radix Select).
if (typeof HTMLElement !== "undefined") {
  const proto = HTMLElement.prototype as any;
  if (typeof proto.hasPointerCapture !== "function") proto.hasPointerCapture = () => false;
  if (typeof proto.setPointerCapture !== "function") proto.setPointerCapture = () => undefined;
  if (typeof proto.releasePointerCapture !== "function") proto.releasePointerCapture = () => undefined;
}
if (typeof Element !== "undefined") {
  const proto = Element.prototype as any;
  if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => undefined;
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;

  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;

  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({ type: "open" });
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ type: "close" });
  }

  emitMessage(data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    this.onmessage?.({ data: payload });
  }
}

(globalThis as any).WebSocket = MockWebSocket;
(globalThis as any).MockWebSocket = MockWebSocket;
