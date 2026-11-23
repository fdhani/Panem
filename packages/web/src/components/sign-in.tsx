import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, LogIn } from "lucide-react";
import { Suspense, lazy, useState } from "react";
import { type LoginEvent, type LoginScope, machineLabel, startLogin } from "../lib/agent-login";
import { keys, queryClient } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

const LoginTerminal = lazy(() => import("./login-terminal"));

type Outcome =
  | { kind: "running" }
  | { kind: "done"; restarted: string[] }
  | { kind: "failed"; message: string };

/**
 * A button that signs an agent in (any agent with a sign-in), with the terminal it opens. Use
 * it wherever an agent may need signing in: the Machines page, an agent's page.
 */
export function SignInButton({
  scope,
  children,
  variant = "primary",
  size = "sm",
  title,
}: {
  scope: LoginScope;
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  /** What the button signs in to, when its text alone doesn't say (tooltip). */
  title?: string;
}) {
  const [session, setSession] = useState<{ ticket: string; pod: string }>();
  const start = useMutation({ mutationFn: () => startLogin(scope), onSuccess: setSession });
  return (
    <>
      <Button
        variant={variant}
        size={size}
        disabled={start.isPending}
        aria-haspopup="dialog"
        title={title}
        onClick={() => start.mutate()}
      >
        <LogIn /> {children ?? scope.label}
      </Button>
      {start.error && (
        <p className="basis-full text-xs break-words text-bad">{start.error.message}</p>
      )}
      {session && (
        <SignInDialog scope={scope} session={session} onClose={() => setSession(undefined)} />
      )}
    </>
  );
}

function SignInDialog({
  scope,
  session,
  onClose,
}: {
  scope: LoginScope;
  session: { ticket: string; pod: string };
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: "running" });
  const where = machineLabel(scope.machine);
  const onEvent = (e: LoginEvent | { type: "closed" }) => {
    if (e.type === "done") {
      setOutcome({ kind: "done", restarted: e.restarted });
      queryClient.invalidateQueries({ queryKey: keys.pods });
      queryClient.invalidateQueries({ queryKey: keys.machines });
    } else if (e.type === "error") {
      setOutcome({ kind: "failed", message: e.message });
    } else if (e.type === "exit" && e.code !== 0) {
      setOutcome({ kind: "failed", message: "The sign-in didn't finish." });
    } else if (e.type === "closed") {
      setOutcome((o) =>
        o.kind === "running" ? { kind: "failed", message: "The sign-in was closed." } : o,
      );
    }
  };
  return (
    <Dialog open onClose={onClose} title={`${scope.label} on ${where}`} wide>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          {scope.pod
            ? `This signs in pod ${session.pod} only.`
            : `Runs in ${session.pod}. One sign-in serves every pod on ${where}.`}{" "}
          Follow the agent's own steps below; Panem passes the terminal through and keeps nothing.
        </p>
        {outcome.kind === "done" ? (
          <p className="flex items-start gap-2 rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              Signed in{scope.pod ? ` in ${session.pod}` : ` on ${where}`}. Restarted in{" "}
              {outcome.restarted.length} pod{outcome.restarted.length === 1 ? "" : "s"}:{" "}
              <span className="font-mono break-all">{outcome.restarted.join(", ")}</span>
            </span>
          </p>
        ) : (
          <Suspense fallback={<p className="text-sm text-muted">Opening…</p>}>
            <LoginTerminal ticket={session.ticket} onEvent={onEvent} />
          </Suspense>
        )}
        {outcome.kind === "failed" && (
          <p className="text-sm break-words text-bad">{outcome.message}</p>
        )}
        <div className="flex justify-end">
          <Button variant={outcome.kind === "done" ? "primary" : "ghost"} onClick={onClose}>
            {outcome.kind === "running" ? "Cancel" : "Close"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
