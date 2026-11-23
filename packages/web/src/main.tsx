import { QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Boxes, Plus, Server, Settings } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { type LiveStatus, queryClient, useLiveEvents } from "./lib/api";
import { AgentPage } from "./pages/agent";
import { MachinePage } from "./pages/machine";
import { MachinesPage } from "./pages/machines";
import { PodPage } from "./pages/pod";
import { PodsPage } from "./pages/pods";
import { SettingsPage } from "./pages/settings";
import { SummonPage } from "./pages/summon";

const nav = [
  { to: "/", label: "Pods", icon: Boxes },
  { to: "/summon", label: "Summon", icon: Plus },
  { to: "/machines", label: "Machines", icon: Server },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

function LiveIndicator({ status }: { status: LiveStatus }) {
  const color = status === "live" ? "bg-ok" : status === "connecting" ? "bg-warn" : "bg-bad";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className={`size-1.5 rounded-full ${color}`} />
      {status}
    </span>
  );
}

function Layout() {
  const live = useLiveEvents();
  return (
    <div className="min-h-dvh pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-8">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-fg">
              <Boxes className="size-3.5" />
            </span>
            Panem
          </Link>
          <nav className="hidden items-center gap-1 sm:flex">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-text [&.active]:bg-surface-2 [&.active]:text-text"
                activeOptions={{ exact: true }}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">
            <LiveIndicator status={live} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-5">
        <Outlet />
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        <div className="grid grid-cols-4">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: true }}
              className="flex h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted [&.active]:text-accent"
            >
              <n.icon className="size-5" />
              {n.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}

const root = createRootRoute({ component: Layout });
const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: "/", component: PodsPage }),
  createRoute({ getParentRoute: () => root, path: "/pods/$id", component: PodPage }),
  createRoute({
    getParentRoute: () => root,
    path: "/pods/$id/agents/$agent",
    component: AgentPage,
  }),
  createRoute({ getParentRoute: () => root, path: "/summon", component: SummonPage }),
  createRoute({ getParentRoute: () => root, path: "/machines", component: MachinesPage }),
  createRoute({ getParentRoute: () => root, path: "/machines/$name", component: MachinePage }),
  createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsPage }),
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
