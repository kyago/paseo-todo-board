import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { commitAll, gitHead, hasRemote, isGitRepo, pushBranch } from "../server/git.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

async function repoWithBareOrigin() {
  const root = await mkdtemp(join(tmpdir(), "todo-git-"));
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  await exec("git", ["init", "-q", "--bare", bare]);
  await exec("git", ["init", "-q", "-b", "main", work]);
  await git(work, "config", "user.email", "t@e");
  await git(work, "config", "user.name", "t");
  await writeFile(join(work, "a.txt"), "a\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "init");
  await git(work, "remote", "add", "origin", bare);
  return { root, bare, work };
}

test("git helpers: repo detection, clean-tree commit, push of a todo branch to origin", async () => {
  const { root, bare, work } = await repoWithBareOrigin();
  assert.equal(await isGitRepo(root), false);
  assert.equal(await isGitRepo(work), true);
  assert.equal(await hasRemote(work), true);
  assert.equal(await commitAll(work, "nothing"), false);
  await git(work, "checkout", "-q", "-b", "todo/abc12345");
  await writeFile(join(work, "b.txt"), "b\n");
  assert.equal(await commitAll(work, "[투두] b"), true);
  assert.equal(await gitHead(work), await git(work, "rev-parse", "HEAD"));
  await pushBranch(work, "todo/abc12345");
  assert.match(await exec("git", ["--git-dir", bare, "branch", "--list"]).then((r) => r.stdout), /todo\/abc12345/);
});
