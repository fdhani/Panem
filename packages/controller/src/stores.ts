import { join } from "node:path";
import { type Job, type PodMeta, readJson, writeJsonAtomic } from "@panem/core";
import { Mutex } from "./git";

/**
 * Controller-side cache of pod metadata. DevPod owns pod existence; this only adds template,
 * refs, and base commit. It can be rebuilt from each pod's ~/.panem/pod.json.
 */
export class PodStore {
  private pods = new Map<string, PodMeta>();
  private readonly lock = new Mutex();
  constructor(private readonly path: string) {}

  static async open(dataDir: string): Promise<PodStore> {
    const s = new PodStore(join(dataDir, "pods.json"));
    const arr = await readJson<PodMeta[]>(s.path, []);
    for (const p of arr) s.pods.set(p.id, p);
    return s;
  }

  all(): PodMeta[] {
    return [...this.pods.values()];
  }
  get(id: string): PodMeta | undefined {
    return this.pods.get(id);
  }
  put(p: PodMeta): Promise<void> {
    this.pods.set(p.id, p);
    return this.flush();
  }
  remove(id: string): Promise<void> {
    this.pods.delete(id);
    return this.flush();
  }
  private flush(): Promise<void> {
    return this.lock.run(() => writeJsonAtomic(this.path, this.all()));
  }
}

export class JobStore {
  private jobs = new Map<string, Job>();
  private readonly lock = new Mutex();
  constructor(private readonly path: string) {}

  static async open(dataDir: string): Promise<JobStore> {
    const s = new JobStore(join(dataDir, "jobs.json"));
    for (const j of await readJson<Job[]>(s.path, [])) s.jobs.set(j.id, j);
    return s;
  }

  all(): Job[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }
  forPod(podId: string): Job | undefined {
    return this.all().find((j) => j.podId === podId && j.status !== "done");
  }
  put(j: Job): Promise<void> {
    this.jobs.set(j.id, j);
    return this.flush();
  }
  remove(id: string): Promise<void> {
    this.jobs.delete(id);
    return this.flush();
  }
  private flush(): Promise<void> {
    return this.lock.run(() => writeJsonAtomic(this.path, this.all()));
  }
}
