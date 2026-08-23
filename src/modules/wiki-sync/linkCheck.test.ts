import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrokenLinks } from "./linkCheck.ts";

// lychee is a separate binary (installed via the Dockerfile, not an npm dep) -- skip rather than
// fail red on a dev machine that hasn't installed it locally. Still fully exercised in any
// environment that does have it on PATH.
const LYCHEE_AVAILABLE = Bun.which("lychee") !== null;
const itIfLychee = test.skipIf(!LYCHEE_AVAILABLE);
if (!LYCHEE_AVAILABLE) {
  console.warn("lychee not found on PATH -- skipping findBrokenLinks tests. See Dockerfile for install instructions.");
}

describe("findBrokenLinks", () => {
  async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "wiki-sync-linkcheck-test-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  itIfLychee("returns nothing when every relative link resolves", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "recaps"), { recursive: true });
      await mkdir(join(dir, "research"), { recursive: true });
      await writeFile(join(dir, "research", "gpu-kernel-optimization.md"), "# GPU\n", "utf8");
      await writeFile(
        join(dir, "recaps", "2026-08-22.md"),
        "- pham shared → [research/gpu-kernel-optimization.md](../research/gpu-kernel-optimization.md)\n" +
          "- see [Source](https://discord.com/channels/1/2/3)\n",
        "utf8",
      );

      expect(await findBrokenLinks(dir)).toEqual([]);
    });
  });

  itIfLychee("flags a relative link whose target file doesn't exist", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "recaps"), { recursive: true });
      await writeFile(
        join(dir, "recaps", "2026-08-22.md"),
        "- pham shared → [research/gpu-kernel-optimization.md](../research/gpu-kernel-optimization.md)\n",
        "utf8",
      );

      const broken = await findBrokenLinks(dir);
      expect(broken).toHaveLength(1);
      expect(broken[0]?.file).toBe("recaps/2026-08-22.md");
      expect(broken[0]?.target.endsWith("research/missing-does-not-exist.md")).toBe(false);
      expect(broken[0]?.target.endsWith("research/gpu-kernel-optimization.md")).toBe(true);
    });
  });

  itIfLychee("ignores external URLs entirely -- never flagged, even when unreachable", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "concepts"), { recursive: true });
      await writeFile(
        join(dir, "concepts", "agent-loop.md"),
        "[a paper](https://this-domain-should-not-resolve.invalid/paper)\n",
        "utf8",
      );

      expect(await findBrokenLinks(dir)).toEqual([]);
    });
  });

  itIfLychee("resolves a link relative to the file it's written in, not the repo root", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "ecosystem", "harnesses"), { recursive: true });
      await mkdir(join(dir, "people"), { recursive: true });
      await writeFile(join(dir, "people", "tzushi.md"), "# tzushi\n", "utf8");
      await writeFile(
        join(dir, "ecosystem", "harnesses", "sushii.md"),
        "Built by [tzushi](../../people/tzushi.md)\n",
        "utf8",
      );

      expect(await findBrokenLinks(dir)).toEqual([]);
    });
  });

  itIfLychee("flags a same-file heading anchor that doesn't exist", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "recaps"), { recursive: true });
      await writeFile(join(dir, "recaps", "2026-08-22.md"), "[jump](#nonexistent-heading)\n## Real heading\n", "utf8");

      const broken = await findBrokenLinks(dir);
      expect(broken).toHaveLength(1);
      expect(broken[0]?.file).toBe("recaps/2026-08-22.md");
      expect(broken[0]?.target.endsWith("#nonexistent-heading")).toBe(true);
    });
  });

  itIfLychee("does not flag a same-file heading anchor that exists", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "recaps"), { recursive: true });
      await writeFile(join(dir, "recaps", "2026-08-22.md"), "[jump](#real-heading)\n## Real heading\n", "utf8");

      expect(await findBrokenLinks(dir)).toEqual([]);
    });
  });
});
