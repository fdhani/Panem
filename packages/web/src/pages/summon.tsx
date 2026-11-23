import type { Template } from "@panem/core";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Rocket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MachineFree } from "../components/resources";
import { MachineDot } from "../components/status";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Field, Input, Select } from "../components/ui/field";
import {
  keys,
  queryClient,
  summon,
  useCredentials,
  useGitCheck,
  useMachines,
  useTemplates,
  useWorkspace,
} from "../lib/api";
import { QueryError } from "./shared";

export function SummonPage() {
  const templates = useTemplates();
  const machines = useMachines();
  const credentials = useCredentials();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const [templateName, setTemplateName] = useState("");
  const [machine, setMachine] = useState("");
  const gitCheck = useGitCheck(templateName);
  const [refs, setRefs] = useState<Record<string, string>>({});

  const template: Template | undefined = useMemo(
    () => templates.data?.templates.find((t) => t.name === templateName),
    [templates.data, templateName],
  );

  useEffect(() => {
    if (!templateName && templates.data?.templates[0]) {
      setTemplateName(templates.data.templates[0].name);
    }
  }, [templates.data, templateName]);
  useEffect(() => {
    const first = machines.data?.find((m) => m.status !== "offline");
    if (!machine && first) setMachine(first.name);
  }, [machines.data, machine]);
  useEffect(() => {
    setRefs(Object.fromEntries((template?.repos ?? []).map((r) => [r.name, r.ref])));
  }, [template]);

  const go = useMutation({
    mutationFn: () => {
      const overrides = Object.fromEntries(
        Object.entries(refs).filter(
          ([name, ref]) => ref.trim() && template?.repos.find((r) => r.name === name)?.ref !== ref,
        ),
      );
      return summon({ template: templateName, machine, refs: overrides });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.pods });
      navigate({ to: "/" });
    },
  });

  if (templates.error) return <QueryError error={templates.error} />;
  if (workspace.data && !workspace.data.dir) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Summon a pod</h1>
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="flex items-center gap-2 font-medium">
            <FolderOpen className="size-4 text-muted" /> No workspace yet
          </h2>
          <p className="text-sm text-muted">
            Pods are built from templates in a workspace folder on the controller. In the folder you
            want to use, run:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm">
            panem workspace init
          </pre>
          <p className="text-xs text-muted">
            It adds an example template, CLAUDE.md and panem.json, without touching files already
            there. No restart needed.
          </p>
        </Card>
      </div>
    );
  }
  const repos = template
    ? [...template.repos].sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
    : [];
  const selected = machines.data?.find((m) => m.name === machine);
  // The controller works out which credentials each template uses (its `env`, or the default).
  const missing = (credentials.data ?? [])
    .filter((c) => !c.set && c.usedBy.includes(templateName))
    .map((c) => c.name);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        go.mutate();
      }}
    >
      <h1 className="text-xl font-semibold">Summon a pod</h1>
      <Card className="flex flex-col gap-4 p-4">
        <Field
          label="Template"
          htmlFor="template"
          hint={template?.description || (templates.isLoading ? "Loading templates…" : undefined)}
        >
          <Select
            id="template"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            required
          >
            {templates.data?.templates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        {templates.data?.warnings
          ?.filter((w) => w.name === templateName)
          .map((w) => (
            <p
              key={w.warning}
              className="rounded-lg bg-warn/10 px-3 py-2 text-sm break-words text-warn"
            >
              {w.warning}
            </p>
          ))}
        {gitCheck.isFetching && (
          <p className="text-xs text-muted">Checking access to the template's repos…</p>
        )}
        {gitCheck.data?.problems.length ? (
          <div className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
            <p className="font-medium">Pods of this template can't clone their repos yet:</p>
            <ul className="mt-1 flex flex-col gap-1">
              {gitCheck.data.problems.map((p) => (
                <li key={`${p.repo}-${p.reason}`} className="break-words">
                  <span className="font-mono">{p.repo}</span>: {p.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {missing.length > 0 && (
          <p className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
            <span className="font-mono break-all">{missing.join(", ")}</span>{" "}
            {missing.length === 1 ? "isn't" : "aren't"} set, so this pod's agent won't be able to
            sign in.{" "}
            <Link to="/settings" className="font-medium underline">
              Set in Settings
            </Link>
          </p>
        )}
        <Field
          label="Machine"
          htmlFor="machine"
          hint={
            selected && (
              <span className="inline-flex items-center gap-1.5">
                <MachineDot status={selected.status} /> {selected.host} is {selected.status}
                {selected.resources && (
                  <>
                    {" · "}
                    <MachineFree machine={selected} />
                  </>
                )}
              </span>
            )
          }
        >
          <Select
            id="machine"
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
            required
          >
            {machines.data?.map((m) => (
              <option key={m.name} value={m.name} disabled={m.status === "offline"}>
                {m.name.replace(/^m-/, "")}
                {m.status === "offline" ? " (offline)" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      {repos.length > 0 && (
        <Card className="flex flex-col gap-4 p-4">
          <div>
            <h2 className="font-medium">Refs</h2>
            <p className="text-xs text-muted">
              Branch, tag, or commit. Only pushed work is cloned.
            </p>
          </div>
          {repos.map((r) => (
            <Field
              key={r.name}
              label={r.primary ? `${r.name} (primary)` : r.name}
              htmlFor={`ref-${r.name}`}
            >
              <Input
                id={`ref-${r.name}`}
                className="font-mono"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={refs[r.name] ?? ""}
                placeholder={r.ref}
                onChange={(e) => setRefs({ ...refs, [r.name]: e.target.value })}
              />
            </Field>
          ))}
        </Card>
      )}

      {templates.data?.errors.length ? (
        <p className="text-xs text-warn">
          Skipped invalid templates: {templates.data.errors.map((e) => e.name).join(", ")}
        </p>
      ) : null}
      {go.error && (
        <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm break-words text-bad">
          {go.error.message}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabled={!templateName || !machine || go.isPending}
      >
        <Rocket /> {go.isPending ? "Summoning…" : "Summon pod"}
      </Button>
    </form>
  );
}
