import type { RuntimeOnboarding } from "../../../../src/sdk/runtime.ts";
import { balanceThreads } from "./balance.ts";
import { printableAddress, t3Connect } from "./connect.ts";
import { scheduledTasks } from "./fleet-tasks.ts";
import { linkBothWays, linkFromHub, unlink } from "./links.ts";

export function t3Onboarding(): RuntimeOnboarding {
  return {
    tool: "t3",
    nodeSignIn: t3Connect,
    link: linkBothWays,
    linkFromHub,
    unlink,
    address: printableAddress,
    balance: balanceThreads,
    fleetTasks: scheduledTasks(),
  };
}
