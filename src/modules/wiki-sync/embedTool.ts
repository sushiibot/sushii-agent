import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { defineTool } from "@earendil-works/pi-coding-agent";
import type { Type } from "typebox";

const ASSETS_DIR_NAME = "assets";
const HASH_LENGTH = 16;

/**
 * The materialized inbox tree lives outside the wiki repo and is wiped each sweep, so a path
 * copied verbatim into a page would be a dead link by the time lychee checks it (and outside the
 * repo entirely, so it'd never even be committed). This tool is how the agent promotes one
 * specific attachment it has decided is worth keeping into the repo, where it becomes a normal
 * committed file with a stable, repo-relative link.
 *
 * Takes `defineTool`/`Type` as parameters rather than importing them statically -- piSession.ts
 * only loads pi-coding-agent's ~14MB of transitive deps via a lazy dynamic import, and a
 * top-level import here would defeat that for every module that imports this factory.
 */
export function createEmbedAttachmentTool(
  defineToolFn: typeof defineTool,
  TypeNs: typeof Type,
  repoDir: string,
  allowedSourceRoot: string,
) {
  const resolvedRoot = resolve(allowedSourceRoot);

  return defineToolFn({
    name: "embed_attachment",
    label: "Embed Attachment",
    description:
      "Copy an already-materialized Discord attachment (its absolute local path, as shown in an inbox " +
      "file's [image: ...]/[application: ...] label) into the wiki repo so it can be committed. Returns " +
      "a repo-relative path to use in markdown: an image with ![alt](assets/<hash>.<ext>), any other " +
      "file with [name](assets/<hash>.<ext>). Only call this for attachments actually worth embedding " +
      "or linking, not every attachment mentioned in the batch.",
    parameters: TypeNs.Object({
      sourcePath: TypeNs.String({ description: "Absolute local path to the materialized attachment, copied from an inbox file's label." }),
      alt: TypeNs.Optional(TypeNs.String({ description: "Short alt text / caption for the agent's own reference when writing the markdown link." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const resolvedSource = resolve(params.sourcePath as string);
        const isInsideRoot = resolvedSource === resolvedRoot || resolvedSource.startsWith(resolvedRoot + sep);
        if (!isInsideRoot) {
          return {
            content: [{ type: "text" as const, text: `Refused: ${params.sourcePath} is not inside the allowed inbox attachment root.` }],
            details: null,
            isError: true,
          };
        }

        let sourceStat: Awaited<ReturnType<typeof stat>>;
        try {
          sourceStat = await stat(resolvedSource);
        } catch {
          return {
            content: [{ type: "text" as const, text: `Refused: ${params.sourcePath} does not exist.` }],
            details: null,
            isError: true,
          };
        }
        if (!sourceStat.isFile()) {
          return {
            content: [{ type: "text" as const, text: `Refused: ${params.sourcePath} is not a regular file.` }],
            details: null,
            isError: true,
          };
        }

        const bytes = await readFile(resolvedSource);
        const hash = createHash("sha256").update(bytes).digest("hex").slice(0, HASH_LENGTH);
        const ext = extname(resolvedSource).toLowerCase();
        const assetsDir = join(repoDir, ASSETS_DIR_NAME);
        const destPath = join(assetsDir, `${hash}${ext}`);
        const relativePath = `${ASSETS_DIR_NAME}/${hash}${ext}`;

        if (!existsSync(destPath)) {
          await mkdir(assetsDir, { recursive: true });
          await copyFile(resolvedSource, destPath);
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Embedded at ${relativePath}. Use ![alt](${relativePath}) for an image, or [name](${relativePath}) ` +
                `for any other file type.`,
            },
          ],
          details: { relativePath },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to embed attachment: ${message}` }],
          details: null,
          isError: true,
        };
      }
    },
  });
}
