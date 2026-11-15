import path from "node:path";
import type { FileFinderApi } from "@ff-labs/fff-node";
import { canonicalPath } from "./paths";

export class QuerySelections {
  private pending = new Map<string, { finder: FileFinderApi; query: string }>();

  remember(
    finder: FileFinderApi,
    query: string,
    root: string,
    files: string[],
  ): void {
    for (const file of files) {
      const absolute = canonicalPath(path.resolve(root, file));
      this.pending.delete(absolute);
      this.pending.set(absolute, { finder, query });
    }
    while (this.pending.size > 256) {
      this.pending.delete(this.pending.keys().next().value!);
    }
  }

  select(absolute: string): void {
    const selection = this.pending.get(absolute);
    if (!selection) return;
    this.pending.delete(absolute);
    if (selection.finder.isDestroyed) return;
    // Learning is best-effort; it must not fail a successful file operation.
    try {
      selection.finder.trackQuery(selection.query, absolute);
    } catch {}
  }

  clear(): void {
    this.pending.clear();
  }
}
