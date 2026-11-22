import type { CredentialInfo } from "@panem/core";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, keys, queryClient, useCredentials } from "../lib/api";
import { timeAgo } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/field";

const NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Mirrors the controller's rule (EnvName), so mistakes show before saving. */
function nameError(name: string): string | undefined {
  if (!name) return undefined;
  if (!NAME.test(name)) return "Uppercase letters, digits and _ only.";
  if (name.startsWith("PANEM_")) return "PANEM_* names are reserved.";
  return undefined;
}

const refresh = () => queryClient.invalidateQueries({ queryKey: keys.credentials });

/** What's open: a credential's actions, the edit form (for one, or a new one), or the remove confirm. */
type Open =
  | { actions: CredentialInfo }
  | { edit: CredentialInfo | "new" }
  | { remove: CredentialInfo };

/** Agent credentials (e.g. CLAUDE_CODE_OAUTH_TOKEN). Write-only: values are never shown. */
export function CredentialsCard() {
  const creds = useCredentials();
  const [open, setOpen] = useState<Open>();
  const close = () => setOpen(undefined);
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="flex items-center gap-2 font-medium">
          <KeyRound className="size-4 text-muted" /> Agent credentials
        </h2>
        <p className="mt-1 text-xs text-muted">
          New pods get the current value; running pods keep the one they started with. Values can be
          replaced but never shown.
        </p>
      </div>
      {creds.error && <p className="text-sm text-bad">{creds.error.message}</p>}
      {creds.data && creds.data.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {creds.data.map((c) => (
            <li key={c.name}>
              {/* The whole row is the tap target: a set credential opens its actions; one that
                  isn't set goes straight to setting it. */}
              <button
                type="button"
                aria-haspopup="dialog"
                className="flex min-h-14 w-full items-center gap-3 py-2 pr-2 pl-3 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                onClick={() => setOpen(c.set ? { actions: c } : { edit: c })}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-sm break-all">{c.name}</span>
                  {c.updatedAt && (
                    <span className="block text-xs text-muted">Updated {timeAgo(c.updatedAt)}</span>
                  )}
                </span>
                <Badge tone={c.set ? "ok" : "warn"}>{c.set ? "Set" : "Not set"}</Badge>
                <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="secondary" aria-haspopup="dialog" onClick={() => setOpen({ edit: "new" })}>
        <Plus /> Add credential
      </Button>
      {open && "edit" in open && (
        <EditDialog
          current={open.edit === "new" ? undefined : open.edit}
          existing={creds.data?.map((c) => c.name) ?? []}
          onClose={close}
        />
      )}
      {open && "remove" in open && <RemoveDialog c={open.remove} onClose={close} />}
      {open && "actions" in open && (
        <Dialog open onClose={close} title={open.actions.name}>
          <div className="flex flex-col gap-4">
            {open.actions.updatedAt && (
              <p className="text-sm text-muted">Updated {timeAgo(open.actions.updatedAt)}.</p>
            )}
            <div className="flex flex-col gap-2">
              <Button onClick={() => setOpen({ edit: open.actions })}>
                <Pencil /> Edit value
              </Button>
              <Button variant="danger" onClick={() => setOpen({ remove: open.actions })}>
                <Trash2 /> Remove
              </Button>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

/** Cancel / primary action: stacked on phones (primary on top), side by side on wider screens. */
function Actions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>;
}

/** Add a credential, or set / replace one's value. Only Save and Cancel. */
function EditDialog({
  current,
  existing,
  onClose,
}: {
  current?: CredentialInfo;
  existing: string[];
  onClose: () => void;
}) {
  const [name, setName] = useState(current?.name ?? "");
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api("PUT", `/api/credentials/${encodeURIComponent(name)}`, { value }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const error = current ? undefined : nameError(name);
  const replaces = !current && existing.includes(name);

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        current ? (current.set ? `Edit ${current.name}` : `Set ${current.name}`) : "Add credential"
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {!current && (
          <Field
            label="Name"
            htmlFor="cred-name"
            hint={error ?? (replaces ? "Already listed: saving replaces its value." : undefined)}
          >
            <Input
              id="cred-name"
              className="font-mono"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="GITHUB_TOKEN"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[\s-]/g, "_"))}
              aria-invalid={!!error}
            />
          </Field>
        )}
        <Field
          label="Value"
          htmlFor="cred-value"
          hint={current?.set ? "Replaces the current value, which can't be shown." : undefined}
        >
          <Input
            id="cred-value"
            type="password"
            autoComplete="off"
            className="font-mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        {save.error && <p className="text-sm text-bad">{save.error.message}</p>}
        <Actions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!name || !!error || !value.trim() || save.isPending}
          >
            Save
          </Button>
        </Actions>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ c, onClose }: { c: CredentialInfo; onClose: () => void }) {
  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/credentials/${encodeURIComponent(c.name)}`),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Remove ${c.name}?`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          New pods won't get it. Running pods keep the value they started with.
        </p>
        {remove.error && <p className="text-sm text-bad">{remove.error.message}</p>}
        <Actions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        </Actions>
      </div>
    </Dialog>
  );
}
