import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { defineTool } from "@earendil-works/pi-coding-agent";
import type { Type } from "typebox";

const ASSETS_DIR_NAME = "assets";
const HASH_LENGTH = 16;
const FALLBACK_EXTENSION = ".bin";

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function resolveExtension(sourcePath: string): string {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === "" || ext === ".") {
    return FALLBACK_EXTENSION;
  }
  return ext;
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/**
 * The materialized inbox tree lives outside the wiki repo and is wiped each sweep, so a path
 * copied verbatim into a page would be a dead link by the time lychee checks it (and outside the
 * repo entirely, so it'd never even be committed). This tool is how the agent promotes one
 * specific attachment it has decided is worth keeping into the repo, where it becomes a normal
 * committed file with a stable link relative to the page that embeds it.
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
  const resolvedRepoDir = resolve(repoDir);

  return defineToolFn({
    name: "embed_attachment",
    label: "Embed Attachment",
    description:
      "Copy an already-materialized Discord attachment (its absolute local path, as shown in an inbox " +
      "file's [image: ...]/[application: ...] label) into the wiki repo so it can be committed. Pass the " +
      "repo-relative path of the page you are embedding into as pagePath; the tool returns a link already " +
      "resolved relative to that page -- use it verbatim, don't hand-write an assets/... path. An image " +
      "uses ![alt](<link>), any other file uses [name](<link>). Only call this for attachments actually " +
      "worth embedding or linking, not every attachment mentioned in the batch.",
    parameters: TypeNs.Object({
      sourcePath: TypeNs.String({ description: "Absolute local path to the materialized attachment, copied from an inbox file's label." }),
      pagePath: TypeNs.String({ description: "Repo-relative path of the wiki page being edited, e.g. \"people/tzushi.md\". The returned link is resolved relative to this page's directory." }),
      alt: TypeNs.Optional(TypeNs.String({ description: "Short alt text / caption to use in the markdown link." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const resolvedSource = resolve(params.sourcePath as string);
        if (!isInside(resolvedSource, resolvedRoot)) {
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

        // Defense-in-depth against a symlink planted inside the inbox tree that would resolve
        // outside allowedSourceRoot even though the lexical path above looked contained.
        const realSource = await realpath(resolvedSource);
        const realRoot = await realpath(resolvedRoot);
        if (!isInside(realSource, realRoot)) {
          return {
            content: [{ type: "text" as const, text: `Refused: ${params.sourcePath} resolves outside the allowed inbox attachment root.` }],
            details: null,
            isError: true,
          };
        }

        const resolvedPagePath = resolve(resolvedRepoDir, params.pagePath as string);
        // Strictly inside (not === resolvedRepoDir): a pagePath of "" or "." would otherwise
        // resolve to the repo root itself, putting dirname() one level above the repo and
        // producing a link with a bogus leading "<repoName>/" segment.
        if (!resolvedPagePath.startsWith(resolvedRepoDir + sep)) {
          return {
            content: [{ type: "text" as const, text: `Refused: pagePath ${params.pagePath} is not inside the wiki repo.` }],
            details: null,
            isError: true,
          };
        }

        const bytes = await readFile(resolvedSource);
        const hash = createHash("sha256").update(bytes).digest("hex").slice(0, HASH_LENGTH);
        const ext = resolveExtension(resolvedSource);
        const assetsDir = join(resolvedRepoDir, ASSETS_DIR_NAME);
        await mkdir(assetsDir, { recursive: true });

        // Guard against a committed `assets -> /elsewhere` symlink redirecting writes outside the repo.
        const realAssetsDir = await realpath(assetsDir);
        const realRepoDir = await realpath(resolvedRepoDir);
        if (!isInside(realAssetsDir, realRepoDir)) {
          return {
            content: [{ type: "text" as const, text: `Refused: assets directory resolves outside the wiki repo.` }],
            details: null,
            isError: true,
          };
        }

        const destPath = join(assetsDir, `${hash}${ext}`);

        try {
          // Exclusive create: fails with EEXIST if anything -- real file OR symlink, dangling or
          // not -- already occupies destPath, so a symlink planted there can never be written
          // through. Writes the already-hashed bytes directly rather than re-reading the source,
          // which also avoids a TOCTOU between what was hashed and what lands on disk.
          await writeFile(destPath, bytes, { flag: "wx" });
        } catch (err) {
          const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
          if (code !== "EEXIST") {
            throw err;
          }
          // destPath is occupied. Treat it as a valid dedup hit ONLY if it's a real regular file
          // whose bytes match what we're embedding. Otherwise -- a symlink planted at the
          // content-addressed path, or a 64-bit-hash collision holding different content -- we'd
          // return a "success" link pointing at unintended or broken content. Refuse instead of
          // vouching for something we didn't write.
          const occupant = await lstat(destPath);
          if (!occupant.isFile()) {
            return {
              content: [{ type: "text" as const, text: `Refused: ${ASSETS_DIR_NAME}/${hash}${ext} is occupied by a non-regular file (possible planted symlink).` }],
              details: null,
              isError: true,
            };
          }
          const existing = await readFile(destPath);
          if (!existing.equals(bytes)) {
            return {
              content: [{ type: "text" as const, text: `Refused: ${ASSETS_DIR_NAME}/${hash}${ext} already holds different content (hash collision or tampering).` }],
              details: null,
              isError: true,
            };
          }
          // Genuine dedup: identical bytes already embedded -- fall through and return the link.
        }

        const link = toPosixRelative(dirname(resolvedPagePath), destPath);
        const displayAlt = (params.alt as string | undefined) ?? "description";

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Embedded at ${link}. Use ![${displayAlt}](${link}) for an image, or [${displayAlt}](${link}) ` +
                `for any other file type.`,
            },
          ],
          details: { relativePath: link },
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
