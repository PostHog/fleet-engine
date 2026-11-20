import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { defaultSources } from "./defaults.ts";
import { profileGuide, profilePath } from "./profile.ts";
import { fakeMachine, hedgeSetup, fakeGitHubHostKeys, githubRepo, machineFile, pushedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const starter = ["--preset", "starter", "--plan", "claude"];
const pushedFiles = async (home: string, repo = "nora/hedge-profile") => (await spawnGit(githubRepo(home, repo), "ls-tree", "--name-only", "main")).split("\n");

function teamSource(): (ref: SourceRef) => Promise<FetchedSource> {
  const dir = temp.make("team-");
  mkdirSync(join(dir, "packs/posthog"), { recursive: true });
  writeFileSync(join(dir, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "Team rules.", profileOrg: "acme" }));
  return async (ref) => ({ ref, dir, packs: await loadPacks(dir) });
}

const teamSetup = (home: string, args: string[], replies: string[], options: { createFails?: string; createFailsAfterMaking?: string; lookupFails?: string; publicRepos?: string[] } = {}) => hedgeSetup(home, args, replies, fakeMachine(home, {}, { org: true, ...options }), teamSource());

describe("hedge setup profile", () => {
  test("asks once, creates the private profile repo, and pushes the answers, the shim, about me, and the guide", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, starter, ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Hedge creates the private repo nora/hedge-profile in your GitHub account and pushes your answers there.");
    expect(result.output).toContain("  ✓ Created the private repo nora/hedge-profile");
    expect(await pushedFiles(home)).toEqual(["README.md", "about-me.md", "hedge.json", "install.sh"]);
    expect(await pushedAnswers(home)).toEqual({
      schema: 1,
      engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
      sources: defaultSources,
      settings: {},
      workflows: {},
      migrations: ["picks-turn-on"],
      packs: ["pull-requests"],
      plan: "claude",
    });
    const guide = await spawnGit(githubRepo(home, "nora/hedge-profile"), "show", "main:README.md");
    expect(guide).toContain("### Quality gates");
    expect(guide).toContain("| `pull-requests.freeReviews` |");
  });

  test("with a team pack that names a profile org, creates the profile there and says where", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Hedge creates the private repo acme/hedge-profile-nora in the acme GitHub org, private to the org, and pushes your answers there.");
    expect(result.output).toContain("  ✓ Created the private repo acme/hedge-profile-nora in the acme org");
    expect(result.output).toContain("  Profile         acme/hedge-profile-nora, private.");
    expect(existsSync(githubRepo(home, "nora/hedge-profile"))).toBe(false);
    expect(await pushedFiles(home, "acme/hedge-profile-nora")).toEqual(["README.md", "about-me.md", "hedge.json", "install.sh"]);
    expect((await pushedAnswers(home, "acme/hedge-profile-nora")).packs).toContain("posthog");
    expect(await spawnGit(githubRepo(home, "acme/hedge-profile-nora"), "show", "main:README.md")).toContain("This repo lives in the acme org, where teammates may read it, so keep secrets out of it.");

    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });
    const second = await teamSetup(home, starter, [""]);
    expect(second.code).toBe(0);
    expect(second.output).toContain("  ✓ Reusing your repo acme/hedge-profile-nora");
  });

  test("reuses a profile repo with the name from before the rename", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    renameSync(githubRepo(home, "nora/hedge-profile"), githubRepo(home, "nora/fleet-profile"));
    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });

    const rerun = await hedgeSetup(home, starter, ["", ""]);

    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/fleet-profile");
    expect(existsSync(githubRepo(home, "nora/hedge-profile"))).toBe(false);
  });

  test("with a team pack, keeps an existing personal profile and says how to move it to the org", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });

    const rerun = await teamSetup(home, starter, [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/hedge-profile");
    expect(rerun.output).toContain("  · Your team keeps profiles in the acme org. To move yours there, run:");
    expect(rerun.output).toContain("      gh api -X POST repos/nora/hedge-profile/transfer -f new_owner=acme -f new_name=hedge-profile-nora");
    expect(rerun.output).toContain(`      git -C ${profilePath(home)} remote set-url origin https://github.com/acme/hedge-profile-nora.git`);
    expect(existsSync(githubRepo(home, "acme/hedge-profile-nora"))).toBe(false);
    expect((await pushedAnswers(home)).packs).toContain("posthog");
  });

  test("with a team pack whose org refuses the repo, creates the profile in the user's account and says why", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""], { createFails: "acme" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("  · The acme org did not let you create acme/hedge-profile-nora (you cannot create repos in acme), so Hedge uses your own account.");
    expect(result.output).toContain("  ✓ Created the private repo nora/hedge-profile");
    expect(existsSync(githubRepo(home, "acme/hedge-profile-nora"))).toBe(false);
    expect((await pushedAnswers(home)).packs).toContain("posthog");
  });

  test("with a team pack, refuses an org profile repo that someone made public, and pushes nothing", async () => {
    const home = temp.make("home-");
    mkdirSync(githubRepo(home, "acme/hedge-profile-nora"), { recursive: true });
    await spawnGit(githubRepo(home, "acme/hedge-profile-nora"), "init", "-q", "--bare", "-b", "main");
    const result = await teamSetup(home, starter, [""], { publicRepos: ["acme/hedge-profile-nora"] });
    expect(result.code).toBe(1);
    expect(result.output).toContain("hedge: acme/hedge-profile-nora is not private. Make it private, then run hedge setup again.");
    expect(existsSync(profilePath(home))).toBe(false);
  });

  test("keeps the org profile this machine already uses after the team pack is removed", async () => {
    const home = temp.make("home-");
    expect((await teamSetup(home, starter, ["", ""])).code).toBe(0);
    const rerun = await teamSetup(home, ["--remove", "posthog"], [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo acme/hedge-profile-nora");
    expect(existsSync(githubRepo(home, "nora/hedge-profile"))).toBe(false);
    expect((await pushedAnswers(home, "acme/hedge-profile-nora")).packs).not.toContain("posthog");
  });

  async function branchCheckout(home: string, origin = "https://github.com/nora/dotfiles.git") {
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    const dotfiles = githubRepo(home, "nora/dotfiles");
    await spawnGit(home, "clone", "-q", "--bare", githubRepo(home, "nora/hedge-profile"), dotfiles);
    await spawnGit(dotfiles, "branch", "hub", "main");
    const checkout = join(home, ".config/coderv2/dotfiles");
    const remotes = `url.${join(home, "github-remotes")}/.insteadOf`;
    await spawnGit(home, "clone", "-q", "--config", `${remotes}=https://github.com/`, "--config", `${remotes}=git@github.com:`, "-b", "hub", "https://github.com/nora/dotfiles.git", checkout);
    await spawnGit(checkout, "remote", "set-url", "origin", origin);
    rmSync(profilePath(home), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux", profileDir: checkout }));
    return { dotfiles, checkout };
  }

  test("uses the profile checkout this machine applies and its branch, and leaves the profile's main alone", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    const mainBefore = await spawnGit(dotfiles, "rev-parse", "main");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/dotfiles");
    expect(JSON.parse(await spawnGit(dotfiles, "show", "hub:hedge.json")).plan).toBe("codex");
    expect(await spawnGit(dotfiles, "rev-parse", "main")).toBe(mainBefore);
    expect((await pushedAnswers(home)).plan).toBe("claude");
    expect(machineFile(home).profileDir).toBe(checkout);
    expect(existsSync(profilePath(home))).toBe(false);
  });

  test("stops before it saves when the checkout's branch tracks no remote branch, and never renames that branch or moves a local main", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    await spawnGit(checkout, "branch", "--unset-upstream");
    await spawnGit(checkout, "update-ref", "-d", "refs/remotes/origin/hub");
    await spawnGit(checkout, "checkout", "-q", "-b", "main");
    await spawnGit(checkout, "commit", "-q", "--allow-empty", "-m", "Only on this machine's main");
    await spawnGit(checkout, "checkout", "-q", "hub");
    const localMain = await spawnGit(checkout, "rev-parse", "main");
    const remoteMain = await spawnGit(dotfiles, "rev-parse", "main");
    const remoteHub = await spawnGit(dotfiles, "rev-parse", "hub");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`${checkout} is on the branch hub, which tracks no remote branch, so setup does not know where to save your answers.`);
    expect(await spawnGit(checkout, "symbolic-ref", "--short", "HEAD")).toBe("hub");
    expect(await spawnGit(checkout, "rev-parse", "main")).toBe(localMain);
    expect([await spawnGit(dotfiles, "rev-parse", "main"), await spawnGit(dotfiles, "rev-parse", "hub")]).toEqual([remoteMain, remoteHub]);
  });

  test("stops before it commits when the checkout's branch tracks a local branch, and moves neither branch", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    await spawnGit(checkout, "branch", "-q", "main", "origin/main");
    await spawnGit(checkout, "branch", "-q", "--set-upstream-to", "main");
    const before = [await spawnGit(checkout, "rev-parse", "hub"), await spawnGit(checkout, "rev-parse", "main"), await spawnGit(dotfiles, "rev-parse", "hub")];

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`${checkout} is on the branch hub, which tracks the local branch main, not origin. Setup takes and saves your answers only on origin, the repo it checks. Run git -C ${checkout} branch --set-upstream-to origin/<branch>, then run hedge setup again.`);
    expect([await spawnGit(checkout, "rev-parse", "hub"), await spawnGit(checkout, "rev-parse", "main"), await spawnGit(dotfiles, "rev-parse", "hub")]).toEqual(before);
  });

  test("stops before it commits when the checkout's branch tracks a remote other than origin, and pushes nothing there", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    const mirror = githubRepo(home, "nora/public-mirror");
    await spawnGit(home, "clone", "-q", "--bare", dotfiles, mirror);
    await spawnGit(checkout, "remote", "add", "mirror", mirror);
    await spawnGit(checkout, "fetch", "-q", "mirror");
    await spawnGit(checkout, "branch", "-q", "--set-upstream-to", "mirror/hub");
    const ahead = join(temp.make("mirror-"), "clone");
    await spawnGit(home, "clone", "-q", "-b", "hub", mirror, ahead);
    await spawnGit(ahead, "commit", "-q", "--allow-empty", "-m", "Only on the mirror");
    await spawnGit(ahead, "push", "-q", "origin", "hub");
    const before = [await spawnGit(checkout, "rev-parse", "hub"), await spawnGit(mirror, "rev-parse", "hub"), await spawnGit(dotfiles, "rev-parse", "hub")];

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`${checkout} is on the branch hub, which tracks mirror/hub, not origin.`);
    expect([await spawnGit(checkout, "rev-parse", "hub"), await spawnGit(mirror, "rev-parse", "hub"), await spawnGit(dotfiles, "rev-parse", "hub")]).toEqual(before);
  });

  test("takes the commits another machine pushed to the origin branch it tracks, and saves on top of them", async () => {
    const home = temp.make("home-");
    const { dotfiles } = await branchCheckout(home);
    const elsewhere = join(temp.make("elsewhere-"), "dotfiles");
    await spawnGit(home, "clone", "-q", "-b", "hub", dotfiles, elsewhere);
    writeFileSync(join(elsewhere, "about-me.md"), "# Changed on another machine\n");
    await spawnGit(elsewhere, "commit", "-q", "-am", "Change about me");
    await spawnGit(elsewhere, "push", "-q", "origin", "hub");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(0);
    expect(JSON.parse(await spawnGit(dotfiles, "show", "hub:hedge.json")).plan).toBe("codex");
    expect(await spawnGit(dotfiles, "show", "hub:about-me.md")).toBe("# Changed on another machine");
  });

  test("takes the commits another machine pushed when origin fetches into its own remote-tracking namespace", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    await spawnGit(checkout, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin-view/*");
    const elsewhere = join(temp.make("elsewhere-"), "dotfiles");
    await spawnGit(home, "clone", "-q", "-b", "hub", dotfiles, elsewhere);
    writeFileSync(join(elsewhere, "about-me.md"), "# Changed on another machine\n");
    await spawnGit(elsewhere, "commit", "-q", "-am", "Change about me");
    await spawnGit(elsewhere, "push", "-q", "origin", "hub");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(0);
    expect(JSON.parse(await spawnGit(dotfiles, "show", "hub:hedge.json")).plan).toBe("codex");
    expect(await spawnGit(dotfiles, "show", "hub:about-me.md")).toBe("# Changed on another machine");
  });

  test("stops before it applies when another machine deleted the branch the checkout tracks on origin, and names why", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    await spawnGit(dotfiles, "branch", "-D", "hub");
    const applied = join(home, "applied");

    const rerun = await hedgeSetup(home, ["--non-interactive"], [], undefined, undefined, 0, "linux", () => writeFileSync(applied, ""));

    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`hedge: could not find refs/heads/hub of origin in ${checkout} after fetching origin: fatal: ambiguous argument '@{upstream}': unknown revision or path not in the working tree. Run git -C ${checkout} pull, then run hedge setup again.`);
    expect(existsSync(applied)).toBe(false);
  });

  test("adds the host keys of github.com, not of the host gh uses by default, before it reaches a profile over SSH, and keeps the lines already there", async () => {
    const home = temp.make("home-");
    const { dotfiles } = await branchCheckout(home, "git@github.com:nora/dotfiles.git");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh/known_hosts"), "example.com ssh-ed25519 AAAAexample");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(0);
    expect(readFileSync(join(home, ".ssh/known_hosts"), "utf8")).toBe(["example.com ssh-ed25519 AAAAexample", ...fakeGitHubHostKeys.map((key) => `github.com ${key}`), ""].join("\n"));
    expect(JSON.parse(await spawnGit(dotfiles, "show", "hub:hedge.json")).plan).toBe("codex");
  });

  test("uses the org repo when its creation reports a failure but the repo was made", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""], { createFailsAfterMaking: "acme" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ✓ Created the private repo acme/hedge-profile-nora in the acme org");
    expect(existsSync(githubRepo(home, "nora/hedge-profile"))).toBe(false);
    expect((await pushedAnswers(home, "acme/hedge-profile-nora")).packs).toContain("posthog");
  });

  test("stops when it cannot tell whether a failed org create made the repo, and creates no personal profile", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""], { createFailsAfterMaking: "acme", lookupFails: "acme" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("hedge: could not look up acme/hedge-profile-nora: HTTP 502: Bad Gateway");
    expect(existsSync(githubRepo(home, "nora/hedge-profile"))).toBe(false);
  });

  test("treats a clone of the personal profile as personal whatever the case of its owner, and keeps a public one", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    symlinkSync(githubRepo(home, "nora/hedge-profile").replace(/nora\/hedge-profile\.git$/, "nora"), join(home, "github-remotes", "NORA"));
    await spawnGit(profilePath(home), "remote", "set-url", "origin", "https://github.com/NORA/hedge-profile.git");
    const rerun = await teamSetup(home, ["--set", "pull-requests.freeReviews=2"], [""], { publicRepos: ["NORA/hedge-profile", "nora/hedge-profile"] });
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo NORA/hedge-profile");
  });

  test("heads a pack's section in the profile guide with its title", () => {
    const guide = profileGuide([{ schema: 1, name: "team", title: "Team Tools", summary: "Team rules.", settings: [{ key: "team.region", question: "Which region?", type: "string" }] }]);
    expect(guide).toContain("### Team Tools");
  });

  test("with Memory on it also creates the memory repo and points memory.repo at it", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("private repos nora/hedge-profile and nora/hedge-memory");
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/hedge-memory" });
  });

  test("with Memory on it refuses a memory repo that is public, before it creates anything", async () => {
    const home = temp.make("home-");
    await spawnGit(home, "init", "-q", "--bare", githubRepo(home, "nora/hedge-memory"));
    const result = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], [""], fakeMachine(home, {}, { publicRepos: ["nora/hedge-memory"] }));
    expect(result.code).toBe(1);
    expect(result.output).toContain("hedge: nora/hedge-memory is not private, and agents write notes about you there. Make it private, or name a private repo with --set memory.repo=<owner/name>.");
    expect(existsSync(githubRepo(home, "nora/hedge-profile"))).toBe(false);
  });

  test("with Memory on and a context repo it keeps memory in a private org context repo, and refuses a public one", async () => {
    const home = temp.make("home-");
    for (const repo of ["acme/context", "acme/open-context"]) await spawnGit(home, "init", "-q", "--bare", githubRepo(home, repo));
    const run = (repo: string) => hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--add", "memory", "--plan", "claude", "--set", `context.repo=${repo}`], [], fakeMachine(home, {}, { publicRepos: ["acme/open-context"] }));
    const refused = await run("acme/open-context");
    expect({ code: refused.code, refused: refused.output.includes("hedge: acme/open-context is not private, and agents write notes about you there. Make it private, or name a private repo with --set context.repo=<owner/name>.") }).toEqual({ code: 1, refused: true });
    expect(existsSync(githubRepo(home, "nora/hedge-profile"))).toBe(false);
    const kept = await run("acme/context");
    expect(kept.code).toBe(0);
    expect(kept.output).toContain("✓ Reusing your repo acme/context");
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(false);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "acme/context" });
  });

  test("with Memory on and a GitHub scp form without a user it saves the owner/name the memory sync can read", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--add", "memory", "--plan", "claude", "--set", "memory.repo=github.com:nora/notes"])).code).toBe(0);
    expect(existsSync(githubRepo(home, "nora/notes"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/notes" });
  });

  test("n creates nothing and keeps the draft for the next run", async () => {
    const home = temp.make("home-");
    const declined = await hedgeSetup(home, starter, ["", "n"]);
    expect(declined.code).toBe(130);
    expect(declined.output).toContain("  Nothing was created.");
    expect(declined.output).toEndWith("Stopped. Run hedge setup again to pick up at Make your profile.");
    expect(existsSync(join(home, "github-remotes"))).toBe(false);
    expect(machineFile(home).setup.draft).toMatchObject({ packs: ["pull-requests"], plan: "claude" });
  });

  test("a rerun on another machine reuses the repos without asking, and the new answers win", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""])).code).toBe(0);
    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });

    const rerun = await hedgeSetup(home, ["--preset", "everyday", "--plan", "both"], [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.prompts).toEqual(["Press ↵ to keep them, or e to change them: "]);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/hedge-profile");
    expect(rerun.output).not.toContain("Created the private repo");
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "orchestration", "communication", "memory"], plan: "both", settings: { "memory.repo": "nora/hedge-memory" } });
    expect(await spawnGit(githubRepo(home, "nora/hedge-profile"), "rev-list", "--count", "main")).toBe("3");
  });

  test("uses a memory repo named on the command, and a second machine keeps the one the profile names", async () => {
    const home = temp.make("home-");
    const custom = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude", "--set", "memory.repo=nora/custom-notes"], ["", ""]);
    expect(custom.code).toBe(0);
    expect(custom.output).toContain("private repos nora/hedge-profile and nora/custom-notes");
    expect(existsSync(githubRepo(home, "nora/custom-notes"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/custom-notes" });

    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });
    const second = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], [""]);
    expect(second.code).toBe(0);
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(false);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/custom-notes" });
  });

  test("pushes the start files a stopped run wrote but did not commit", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    const dir = profilePath(home);
    await spawnGit(dir, "rm", "-q", "--cached", "README.md");
    await spawnGit(dir, "commit", "-q", "-m", "Lose the guide");
    await spawnGit(dir, "push", "-q");
    const rerun = await hedgeSetup(home, ["--set", "pull-requests.freeReviews=2"]);
    expect(rerun.code).toBe(0);
    expect(await pushedFiles(home)).toContain("README.md");
  });

  test("refuses a profile folder cloned from a repo with a longer name", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    await spawnGit(profilePath(home), "remote", "set-url", "origin", "https://github.com/nora/hedge-profile-public.git");
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux" }));
    const rerun = await hedgeSetup(home, starter, ["", ""]);
    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`hedge: ${profilePath(home)} is a clone of nora/hedge-profile-public, not nora/hedge-profile.`);
  });

  test.each([["plain text", ["pretend", "pass", "x"]], ["text with an apostrophe", ["pretend", "pa'ss", "x"]], ["text with a double quote", ["pretend", 'pa"ss', "x"]], ["text with an at sign", ["pretend", "pa@ss", "x"]]])("names a profile folder that pushes outside GitHub as another remote, with no part of that address, when its sign-in, query and fragment hold a password that is %s", async (_, parts) => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    const password = parts.join("-");
    await spawnGit(profilePath(home), "config", "remote.origin.pushurl", `HTTPS://nora:${password}@git.example/nora/my mirror.git?access_token=${password}#${password}.`);
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux" }));
    const rerun = await hedgeSetup(home, starter, ["", ""]);
    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`hedge: ${profilePath(home)} is a clone of another remote, not nora/hedge-profile.`);
    expect(rerun.output).not.toContain("git.example");
    for (const part of password.split(/['"@]/)) expect(rerun.output).not.toContain(part);
  });

  test("refuses to take over a folder that is not the profile", async () => {
    const home = temp.make("home-");
    mkdirSync(profilePath(home), { recursive: true });
    const result = await hedgeSetup(home, starter, ["", ""]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`hedge: ${profilePath(home)} exists and is not your profile. Move it away, then run hedge setup again.`);
  });
});
