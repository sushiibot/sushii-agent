export interface BrokenLink {
  /** Repo-relative path of the page containing the broken link. */
  file: string;
  /** The link target exactly as lychee resolved it. */
  target: string;
  reason: string;
}

interface LycheeError {
  url: string;
  status?: { text?: string };
}

interface LycheeReport {
  error_map?: Record<string, LycheeError[]>;
}

/**
 * Every internal wiki link -- relative file references and same-file heading anchors -- that
 * lychee can't resolve. Deterministic substitute for asking the model to double-check its own
 * `../` depth with find/ls: a model can forget to check, or check with a wrong query, where this
 * either resolves the link or it doesn't.
 *
 * `--offline` means only local files/fragments are ever checked over the network -- external
 * `## Sources` URLs show up in lychee's own `excluded_map`, not `error_map`, so a flaky external
 * site can never fail this gate. Errors are read from lychee's JSON report body, not its exit
 * code: lychee's exit-code semantics for partial-failure cases aren't documented precisely
 * enough to gate on directly, but the report itself is unambiguous.
 */
export async function findBrokenLinks(repoDir: string): Promise<BrokenLink[]> {
  const proc = Bun.spawn({
    cmd: ["lychee", "--offline", "--no-progress", "--include-fragments", "--format", "json", "."],
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;

  let report: LycheeReport;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`lychee produced no parseable JSON report (see Dockerfile for install): ${stderr || stdout}`.trim());
  }

  const broken: BrokenLink[] = [];
  for (const [rawFile, errors] of Object.entries(report.error_map ?? {})) {
    // Keyed as "./recaps/foo.md" since we pass "." as the scan root -- strip that prefix so
    // `file` is a plain repo-relative path, consistent with everywhere else in wiki-sync.
    const file = rawFile.replace(/^\.\//, "");
    for (const error of errors) {
      broken.push({ file, target: error.url, reason: error.status?.text ?? "broken link" });
    }
  }
  return broken;
}
