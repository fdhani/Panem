import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { type LoginEvent, loginSocketUrl } from "../lib/agent-login";

/**
 * A terminal attached to an agent's sign-in in a pod (loaded only when a sign-in opens). It
 * shows what the agent's own sign-in prints and sends what's typed or pasted; Panem only
 * passes it through. Reports how it ended through onEvent.
 */
export default function LoginTerminal({
  ticket,
  onEvent,
}: {
  ticket: string;
  onEvent: (e: LoginEvent | { type: "closed" }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const report = useRef(onEvent);
  report.current = onEvent;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      theme: {
        background: css.getPropertyValue("--surface-2").trim() || "#f4f4f5",
        foreground: css.getPropertyValue("--text").trim() || "#18181b",
        cursor: css.getPropertyValue("--accent").trim() || undefined,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.focus();

    const sock = new WebSocket(loginSocketUrl(ticket));
    sock.binaryType = "arraybuffer";
    const enc = new TextEncoder();
    const sendSize = () => {
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ resize: [term.cols, term.rows] }));
      }
    };
    sock.onopen = sendSize;
    sock.onmessage = (m) => {
      if (typeof m.data === "string") {
        try {
          report.current(JSON.parse(m.data) as LoginEvent);
        } catch {
          // not an event
        }
        return;
      }
      term.write(new Uint8Array(m.data as ArrayBuffer));
    };
    sock.onclose = () => report.current({ type: "closed" });
    const input = term.onData((d) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(enc.encode(d));
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      sendSize();
    });
    resize.observe(el);

    return () => {
      resize.disconnect();
      input.dispose();
      sock.onclose = null;
      sock.close();
      term.dispose();
    };
  }, [ticket]);

  return (
    <div
      ref={box}
      className="h-[50vh] min-h-56 w-full overflow-hidden rounded-lg bg-surface-2 p-2 sm:h-96"
      aria-label="Sign-in terminal"
    />
  );
}
