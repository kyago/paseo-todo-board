import { execFile } from "node:child_process";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// The daemon subprocess does not inherit a login shell's PATH; Homebrew's gh/git live here on macOS.
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 120_000, env: { ...process.env, PATH }, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export async function gitHead(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "HEAD"])) || null;
  } catch {
    return null;
  }
}

export const isGitRepo = async (cwd: string): Promise<boolean> => (await gitHead(cwd)) !== null;

export async function hasRemote(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

/** Stages everything and commits; false when the tree was clean. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ["add", "-A"]);
  if (!(await git(cwd, ["status", "--porcelain"]))) return false;
  await git(cwd, ["commit", "-q", "-m", message]);
  return true;
}

export const pushBranch = (cwd: string, branch: string) => git(cwd, ["push", "-q", "-u", "origin", branch]);

async function ghBin(): Promise<string> {
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return "gh";
}

/** Opens a draft pull request for the current branch and returns its URL. */
export async function createDraftPr(cwd: string, title: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "todo-board-pr-"));
  const bodyFile = join(dir, "body.md");
  await writeFile(bodyFile, body);
  try {
    const { stdout } = await exec(await ghBin(), ["pr", "create", "--draft", "--title", title, "--body-file", bodyFile], {
      cwd,
      timeout: 120_000,
      env: { ...process.env, PATH },
    });
    const url = stdout.trim().split("\n").find((line) => line.startsWith("http"));
    if (!url) throw new Error(`gh가 URL을 돌려주지 않았습니다: ${stdout.trim()}`);
    return url;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
