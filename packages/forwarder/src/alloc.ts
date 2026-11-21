import { readJson, writeJsonAtomic } from "@panem/core";

interface PodAlloc {
  start: number;
  /** pod port -> slot (1..blockSize-1). Slot 0 is the index page. */
  slots: Record<string, number>;
}

/**
 * Hands out a block of host ports per pod and a stable slot per pod port.
 * Persisted so links survive forwarder restarts and pod stop/start.
 */
export class Allocator {
  private pods: Record<string, PodAlloc> = {};
  private dirty = false;

  constructor(
    private readonly range: [number, number],
    private readonly blockSize: number,
    private readonly path?: string,
  ) {
    if (range[1] - range[0] + 1 < blockSize) throw new Error("port range smaller than one block");
  }

  async load(): Promise<void> {
    if (!this.path) return;
    const saved = await readJson<Record<string, PodAlloc>>(this.path, {});
    // Drop blocks that no longer fit the configured range/size.
    for (const [id, a] of Object.entries(saved)) {
      if (this.validStart(a.start)) this.pods[id] = a;
    }
  }

  async save(): Promise<void> {
    if (!this.path || !this.dirty) return;
    this.dirty = false;
    await writeJsonAtomic(this.path, this.pods);
  }

  private validStart(start: number): boolean {
    return (
      start >= this.range[0] &&
      start + this.blockSize - 1 <= this.range[1] &&
      (start - this.range[0]) % this.blockSize === 0
    );
  }

  /** Block start for a pod without allocating. */
  peek(podId: string): number | undefined {
    return this.pods[podId]?.start;
  }

  /** Block start for a pod, allocating one if needed. Undefined when the range is full. */
  block(podId: string): number | undefined {
    const existing = this.pods[podId];
    if (existing) return existing.start;
    const used = new Set(Object.values(this.pods).map((p) => p.start));
    for (let s = this.range[0]; s + this.blockSize - 1 <= this.range[1]; s += this.blockSize) {
      if (!used.has(s)) {
        this.pods[podId] = { start: s, slots: {} };
        this.dirty = true;
        return s;
      }
    }
    return undefined;
  }

  /**
   * Assign slots: declared ports first (ascending), then other live ports in ascending order.
   * Existing assignments never move. Returns ports that didn't fit.
   */
  assign(podId: string, declared: number[], live: number[]): number[] {
    const a = this.pods[podId];
    if (!a) throw new Error(`no block for ${podId}`);
    const taken = new Set(Object.values(a.slots));
    const unmapped: number[] = [];
    const wanted = [...new Set([...declared.sort((x, y) => x - y), ...live.sort((x, y) => x - y)])];
    for (const port of wanted) {
      if (a.slots[port] !== undefined) continue;
      let slot = 1;
      while (taken.has(slot)) slot++;
      if (slot >= this.blockSize) {
        if (live.includes(port)) unmapped.push(port);
        continue;
      }
      a.slots[port] = slot;
      taken.add(slot);
      this.dirty = true;
    }
    return unmapped;
  }

  slots(podId: string): { podPort: number; slot: number; hostPort: number }[] {
    const a = this.pods[podId];
    if (!a) return [];
    return Object.entries(a.slots)
      .map(([p, slot]) => ({ podPort: Number(p), slot, hostPort: a.start + slot }))
      .sort((x, y) => x.slot - y.slot);
  }

  release(podId: string): boolean {
    if (!this.pods[podId]) return false;
    delete this.pods[podId];
    this.dirty = true;
    return true;
  }

  ids(): string[] {
    return Object.keys(this.pods);
  }
}
