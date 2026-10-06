import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const githubPushPolicyPath = (agentDir: string) => join(agentDir, "config", "github-push.json");
type Grant = { repo: string; branch: string };

/** Owner-confirmed destinations only; repo instructions and memory cannot create grants. */
export function pushGrants(agentDir: string): Grant[] {
  const file = githubPushPolicyPath(agentDir);
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data) || !data.every((g) => g && typeof g.repo === "string" && typeof g.branch === "string"))
    throw new Error("Invalid GitHub push policy. Ask the owner to repair it.");
  return data;
}

export function setPushGrant(agentDir: string, repo: string, branch: string, allowed: boolean): void {
  const grants = pushGrants(agentDir).filter((g) => g.repo !== repo || g.branch !== branch);
  if (allowed) grants.push({ repo, branch });
  const file = githubPushPolicyPath(agentDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(grants, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
