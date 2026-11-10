import { readFile } from "node:fs/promises";

const conventional = /^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: \S[^\r\n]*$/;

export function validatePolicy(title: string, subjects: string[], parentCount: number) {
  if (!conventional.test(title)) throw new Error("PR title must follow Conventional Commits");
  if (subjects.length !== 1)
    throw new Error("PR must contain exactly one commit relative to its base");
  if (!conventional.test(subjects[0]))
    throw new Error("Commit subject must follow Conventional Commits");
  if (parentCount !== 1) throw new Error("PR commit must not be a merge or root commit");
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error("Cannot inspect PR history; fetch the complete base and head history");
  return result.stdout.toString().trim();
}

export async function checkPullRequest(eventPath: string) {
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const pr = event.pull_request;
  if (
    typeof pr?.title !== "string" ||
    ![pr?.base?.sha, pr?.head?.sha].every(
      (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    )
  ) {
    throw new Error("Expected a pull_request event with base/head commit hashes");
  }
  const range = git("rev-list", `${pr.base.sha}..${pr.head.sha}`);
  const commits = range ? range.split("\n") : [];
  const subjects = commits.map((sha) => git("show", "-s", "--format=%s", sha));
  const parents = git("rev-list", "--parents", "-n", "1", pr.head.sha).split(/\s+/).length - 1;
  validatePolicy(pr.title, subjects, parents);
}

if (import.meta.main) {
  try {
    const event = process.env.GITHUB_EVENT_PATH;
    if (!event) throw new Error("GITHUB_EVENT_PATH is required");
    await checkPullRequest(event);
    console.log("PR policy passed: one non-merge Conventional Commit and a compliant title");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "PR policy failed");
    process.exitCode = 1;
  }
}
