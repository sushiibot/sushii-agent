// Real workspace memory files travel over the workspace RPC and owner-only gateway into the app.
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, nonce, stack, test } from "../lib/harness.ts";

const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };
interface MemoryFile {
  id: string;
  path: string;
}

test("Memory reads saved facts and daily notes from real workspace files without allowing writes", async ({
  page,
  request,
  watch,
}) => {
  const tag = nonce();
  const saved = `memory/e2e-saved-${tag}.md`;
  const daily = "memory/2001-01-01.md";
  const privateFile = `e2e-private-${tag}.md`;
  const linked = `memory/e2e-linked-${tag}.md`;
  const savedText = `# Saved project\n\nThe project uses lavender notebooks ${tag}.`;
  const dailyText = `# Daily memory\n\nReviewed the notebook project ${tag}.`;
  await mkdir(join(stack.wsHome, "memory"), { recursive: true });
  await writeFile(join(stack.wsHome, saved), savedText);
  await writeFile(join(stack.wsHome, daily), dailyText);
  await writeFile(join(stack.wsHome, privateFile), `Private content ${tag}`);
  await symlink(join(stack.wsHome, privateFile), join(stack.wsHome, linked));
  try {
    const me = await request.get("/api/me", { headers: SAME_ORIGIN });
    expect((await me.json()).features).toContain("memory");
    const overviewResponse = await request.get("/api/memory", {
      headers: SAME_ORIGIN,
    });
    expect(overviewResponse.status()).toBe(200);
    expect(overviewResponse.headers()["cache-control"]).toContain("no-store");
    const overview = (await overviewResponse.json()) as {
      files: MemoryFile[];
      writes: unknown[];
    };
    const file = overview.files.find((f) => f.path === saved);
    expect(file).toBeDefined();
    expect(overview.files.some((f) => f.path === daily)).toBe(true);
    expect(overview.files.some((f) => f.path === linked || f.path === privateFile)).toBe(false);
    expect(overview.writes).toEqual([]);
    const detail = await request.get(`/api/memory/files/${file!.id}`, {
      headers: SAME_ORIGIN,
    });
    expect(detail.status()).toBe(200);
    expect((await detail.json()).file.content).toBe(savedText);
    for (const path of ["memory/absent-e2e.md", linked, `../${privateFile}`]) {
      const id = Buffer.from(path).toString("base64url");
      expect((await request.get(`/api/memory/files/${id}`, { headers: SAME_ORIGIN })).status()).toBe(404);
    }
    const mutationHeaders = {
      Origin: stack.baseURL,
      "Sec-Fetch-Site": "same-origin",
    };
    expect(
      (
        await request.post(`/api/memory/files/${file!.id}`, {
          headers: mutationHeaders,
          data: { content: "changed" },
        })
      ).status(),
    ).toBe(405);
    expect(
      (
        await request.post("/api/memory/writes/fake/revert", {
          headers: mutationHeaders,
          data: {},
        })
      ).status(),
    ).toBe(405);
    expect(await readFile(join(stack.wsHome, saved), "utf8")).toBe(savedText);

    await page.goto("/memory");
    await expect(page.getByRole("heading", { name: "Long-term files" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Find a memory file" }).fill(tag);
    await page.getByRole("link", { name: new RegExp(`e2e-saved-${tag}`) }).click();
    await expect(page.getByRole("region", { name: "What the file says" })).toContainText(`lavender notebooks ${tag}`);
    await page.goto("/memory");
    await page.getByRole("tab", { name: "Daily notes", exact: true }).click();
    await expect(page.getByRole("link", { name: new RegExp(`e2e-saved-${tag}`) })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Find a memory file" }).fill("2001-01-01");
    await page.getByRole("link", { name: /memory\/2001-01-01\.md/ }).click();
    await expect(page.getByRole("region", { name: "What the file says" })).toContainText(
      `Reviewed the notebook project ${tag}`,
    );
    expect(await watch.violations()).toEqual([]);
  } finally {
    await Promise.all([saved, daily, privateFile, linked].map((path) => rm(join(stack.wsHome, path), { force: true })));
  }
});
