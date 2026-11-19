import { homedir, hostname } from "node:os";
import { modelFor } from "../../base/lib/models.ts";
import { capture, captureAgent, type Agent } from "../lib/capture.ts";
import { canvasId, hubSources, type Sources } from "../lib/source.ts";
import { librarySettings, writePointer } from "../lib/config.ts";
import { runGit, type Git } from "../lib/git.ts";
import { routerAgent, share, t3ShareDeps, type Route, type ShareDeps } from "../lib/share.ts";

type Env = Record<string, string | undefined>;
export type SlackCaptureDeps = { env: Env; home: string; git: Git; agent: () => Agent; sources: Sources; today: () => string; share: (owner: string) => ShareDeps };

const isRoute = (value: unknown): value is Route =>
  typeof value === "object" && value !== null && ["host", "id", "title", "message"].every((key) => typeof (value as Record<string, unknown>)[key] === "string");

export async function slackCapture(request: string, deps: SlackCaptureDeps): Promise<{ code: number; output: string }> {
  try {
    const asked = JSON.parse(request) as Record<string, unknown>;
    const library = librarySettings(deps.env, deps.home);
    writePointer(deps.home, library);
    if ("note" in asked) {
      const { note, sentBefore = [] } = asked as { note?: Record<string, unknown>; sentBefore?: unknown };
      if (!note || typeof note.title !== "string" || typeof note.url !== "string" || typeof note.text !== "string" || !Array.isArray(sentBefore) || !sentBefore.every(isRoute)) {
        throw new Error("sending a note needs its title, url and text, and the routes it went to before");
      }
      const shared = await share({ title: note.title, url: note.url, text: note.text }, deps.share(library.owner), sentBefore);
      return { code: 0, output: JSON.stringify(shared) };
    }
    const { source, material, startedAt, canvases = [] } = asked;
    if (typeof source !== "string" || !/^https:\/\//.test(source) || (material !== undefined && typeof material !== "string")) throw new Error("the Slack capture needs an https source and the thread's text");
    if (startedAt !== undefined && (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt)))) throw new Error("the Slack capture's startedAt is not a time");
    if (!Array.isArray(canvases) || canvases.length > 10 || !canvases.every((id) => typeof id === "string" && canvasId.test(id))) throw new Error("the Slack capture's canvases are not up to 10 Slack canvas ids");
    const saved = await capture({ source, via: "slack", material, canvases, startedAt }, { home: deps.home, library, agent: deps.agent(), sources: deps.sources, git: deps.git, today: deps.today });
    return { code: 0, output: JSON.stringify(saved) };
  } catch (error) {
    return { code: 1, output: JSON.stringify({ failed: (error as Error).message }) };
  }
}

if (import.meta.main) {
  const { code, output } = await slackCapture(await Bun.stdin.text(), {
    env: Bun.env, home: Bun.env.HOME ?? homedir(), git: runGit, agent: () => captureAgent(modelFor("survey"), Bun.env.HOME ?? homedir()), sources: hubSources(Bun.env.HOME ?? homedir()), today: () => new Date().toISOString().slice(0, 10),
    share: (owner) => t3ShareDeps({ owner, host: hostname(), route: routerAgent(modelFor("survey")) }),
  });
  console.log(output);
  process.exit(code);
}
