import type { Machine, Pod } from "@panem/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useState } from "react";
import { machineLabel } from "../lib/agent-login";
import { api, keys, queryClient } from "../lib/api";
import { formatBytes } from "../lib/bytes";
import { timeAgo } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog } from "./ui/dialog";

type MR = NonNullable<Machine["resources"]>;

/** A bar: how much of `total` is used (total - free), warning-coloured when low. */
function Meter({
  free,
  total,
  low,
  label,
}: { free: number; total: number; low?: boolean; label: string }) {
  const used = total > 0 ? Math.min(100, Math.max(0, ((total - free) / total) * 100)) : 0;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(used)}
    >
      <div
        className={`h-full rounded-full ${low ? "bg-warn" : "bg-accent/70"}`}
        style={{ width: `${used}%` }}
      />
    </div>
  );
}

/** Whether a machine is low on anything, and a short phrase for it. */
export function lowText(m: Machine): string | undefined {
  const r = m.resources;
  if (!r?.low) return undefined;
  const parts: string[] = [];
  if (r.low.mem && r.mem) parts.push(`${formatBytes(r.mem.available, "ram")} RAM free`);
  if (r.low.disk && r.disk) parts.push(`${formatBytes(r.disk.free)} disk free`);
  return parts.length ? parts.join(", ") : undefined;
}

/** One line for lists: "RAM 11.4 / 15.5 GiB free · Disk 120 / 465 GB free". */
export function MachineResourcesLine({ machine }: { machine: Machine }) {
  const r = machine.resources;
  if (!r || (!r.mem && !r.disk)) return null;
  return (
    <p className="flex flex-wrap gap-x-1.5 text-xs text-muted">
      {r.mem && (
        <span className={`whitespace-nowrap ${r.low?.mem ? "text-warn" : ""}`}>
          RAM {formatBytes(r.mem.available, "ram")} / {formatBytes(r.mem.total, "ram")} free
        </span>
      )}
      {r.mem && r.disk && <span aria-hidden> · </span>}
      {r.disk && (
        <span className={`whitespace-nowrap ${r.low?.disk ? "text-warn" : ""}`}>
          Disk {formatBytes(r.disk.free)} / {formatBytes(r.disk.total)} free
        </span>
      )}
    </p>
  );
}

/** A machine's resources: RAM, Docker disk, its pods' share, and unused volumes to clean up. */
export function MachineResourcesCard({ machine }: { machine: Machine }) {
  const r = machine.resources;
  const [pruning, setPruning] = useState(false);
  if (!r) {
    return (
      <Card className="p-4 text-sm text-muted">
        {machine.status === "offline" ? "Offline: no resource figures." : "Measuring…"}
      </Card>
    );
  }
  const mac = r.os === "Darwin";
  return (
    <Card className="flex flex-col gap-4 p-4">
      {mac && (
        <p className="text-sm text-muted">
          Resource usage isn't shown for macOS hosts yet: with Docker Desktop, containers run in a
          VM, and the Mac's own figures would be misleading.
        </p>
      )}
      {r.mem && (
        <Row label="RAM" note={r.low?.mem ? "Low" : undefined}>
          <Meter free={r.mem.available} total={r.mem.total} low={r.low?.mem} label="RAM in use" />
          <p className="text-xs text-muted">
            {formatBytes(r.mem.available, "ram")} available of {formatBytes(r.mem.total, "ram")}
          </p>
        </Row>
      )}
      {r.disk && (
        <Row label="Docker disk" note={r.low?.disk ? "Low" : undefined}>
          <Meter
            free={r.disk.free}
            total={r.disk.total}
            low={r.low?.disk}
            label="Docker disk in use"
          />
          <p className="text-xs text-muted">
            {formatBytes(r.disk.free)} free of {formatBytes(r.disk.total)} ·{" "}
            <span className="font-mono">{r.disk.path}</span>
          </p>
        </Row>
      )}
      {r.pods && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Panem's pods</dt>
          <dd>
            {formatBytes(r.pods.mem, "ram")} RAM · {formatBytes(r.pods.storage)} storage
          </dd>
          {!!r.sharedImages && (
            <>
              <dt className="text-muted">Their images</dt>
              <dd>
                {formatBytes(r.sharedImages)}{" "}
                <span className="text-xs text-muted">shared, so not in pod figures</span>
              </dd>
            </>
          )}
        </dl>
      )}
      {r.orphans && r.orphans.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <p className="text-sm">
            {r.orphans.count} unused Docker-in-Docker volume{r.orphans.count === 1 ? "" : "s"} ·{" "}
            {formatBytes(r.orphans.bytes)}
          </p>
          <Button size="sm" aria-haspopup="dialog" onClick={() => setPruning(true)}>
            <Trash2 /> Clean up…
          </Button>
        </div>
      )}
      <p className="text-xs text-muted">
        Updated {timeAgo(r.at)}
        {r.stale && (
          <span className="text-warn"> · couldn't refresh{r.error ? `: ${r.error}` : ""}</span>
        )}
      </p>
      {pruning && <PruneDialog machine={machine} onClose={() => setPruning(false)} />}
    </Card>
  );
}

function Row({
  label,
  note,
  children,
}: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{label}</span>
        {note && (
          <Badge tone="warn">
            <AlertTriangle className="size-3" /> {note}
          </Badge>
        )}
      </div>
      {children}
    </div>
  );
}

/** Unused DinD volumes on a machine, measured now, deleted after confirming. */
function PruneDialog({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const where = machineLabel(machine.name);
  const list = useQuery({
    queryKey: ["orphans", machine.name],
    queryFn: () =>
      api<{ name: string; size?: number }[]>(
        "GET",
        `/api/machines/${encodeURIComponent(machine.name)}/orphans`,
      ),
  });
  const prune = useMutation({
    mutationFn: (volumes: string[]) =>
      api<{
        removed: { name: string; size?: number }[];
        skipped: { name: string; reason: string }[];
      }>("POST", `/api/machines/${encodeURIComponent(machine.name)}/prune`, { volumes }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.machines }),
  });
  const vols = list.data ?? [];
  const total = vols.reduce((a, v) => a + (v.size ?? 0), 0);
  return (
    <Dialog open onClose={onClose} title={`Unused volumes on ${where}`}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted">
          Docker-in-Docker volumes that no container uses and no pod recorded: left by pods deleted
          before Panem removed them, or by DevPod workspaces made outside Panem. Deleting them
          deletes the images and containers inside.
        </p>
        {list.isLoading && <p className="text-muted">Checking…</p>}
        {list.error && <p className="text-bad">{(list.error as Error).message}</p>}
        {prune.data ? (
          <div className="flex flex-col gap-1">
            <p className="text-ok">
              Deleted {prune.data.removed.length} volume
              {prune.data.removed.length === 1 ? "" : "s"}, freeing{" "}
              {formatBytes(prune.data.removed.reduce((a, v) => a + (v.size ?? 0), 0))}.
            </p>
            {prune.data.skipped.map((s) => (
              <p key={s.name} className="break-all text-xs text-muted">
                Kept {s.name}: {s.reason}
              </p>
            ))}
          </div>
        ) : (
          vols.length > 0 && (
            <ul className="flex max-h-64 flex-col divide-y divide-border overflow-auto rounded-lg border border-border">
              {vols.map((v) => (
                <li key={v.name} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={v.name}>
                    {v.name}
                  </span>
                  <span className="shrink-0 text-xs">{formatBytes(v.size)}</span>
                </li>
              ))}
            </ul>
          )
        )}
        {list.data && vols.length === 0 && !prune.data && (
          <p className="text-muted">Nothing to clean up.</p>
        )}
        {prune.error && <p className="text-bad">{(prune.error as Error).message}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            {prune.data ? "Close" : "Cancel"}
          </Button>
          {!prune.data && vols.length > 0 && (
            <Button
              variant="danger"
              disabled={prune.isPending}
              onClick={() => prune.mutate(vols.map((v) => v.name))}
            >
              <Trash2 /> Delete {vols.length} volume{vols.length === 1 ? "" : "s"} (
              {formatBytes(total)})
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** A pod's RAM and storage, with what the figures include. */
export function PodResourcesCard({ pod }: { pod: Pod }) {
  const r = pod.resources;
  if (!r) return null;
  const storage =
    r.writable !== undefined || r.dind !== undefined
      ? (r.writable ?? 0) + (r.dind ?? 0)
      : undefined;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-medium">Resources</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {r.mem !== undefined && (
          <>
            <dt className="text-muted">RAM in use</dt>
            <dd>{formatBytes(r.mem, "ram")}</dd>
          </>
        )}
        {storage !== undefined && (
          <>
            <dt className="text-muted">Storage</dt>
            <dd>
              {formatBytes(storage)}
              <span className="block text-xs text-muted">
                {formatBytes(r.writable)} changed in the pod · {formatBytes(r.dind)} inner Docker
              </span>
            </dd>
          </>
        )}
      </dl>
      <p className="text-xs text-muted">
        RAM includes containers started inside the pod (Docker-in-Docker). Storage is the files
        changed in the pod plus its own Docker's images and containers; the workspace folder, the
        shared sign-in and the base image (shared with other pods) aren't counted.
        {r.stale && <span className="text-warn"> Couldn't refresh: these are older figures.</span>}
      </p>
    </Card>
  );
}

/** Free RAM and disk on a machine, for choosing one (Summon). */
export function MachineFree({ machine }: { machine: Machine }) {
  const r = machine.resources;
  if (!r || (!r.mem && !r.disk)) return null;
  const low = r.low?.mem || r.low?.disk;
  return (
    <span className={low ? "text-warn" : undefined}>
      {r.mem && `${formatBytes(r.mem.available, "ram")} RAM`}
      {r.mem && r.disk && " · "}
      {r.disk && `${formatBytes(r.disk.free)} disk`} free{low ? " (low)" : ""}
    </span>
  );
}
