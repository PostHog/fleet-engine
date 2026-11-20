import type { Plan } from "../pack/types.ts";
import { filesAdapter, type Adapter } from "../reconciler/apply.ts";
import { fleetAdapter } from "./fleet/adapter.ts";
import { identityAdapter } from "./identity/adapter.ts";
import { jobsAdapter } from "./jobs/adapter.ts";
import { providerConfigAdapter } from "./provider-config/adapter.ts";
import { runtimeAdapter } from "./runtime/adapter.ts";

export async function engineAdapters(plan?: Plan): Promise<Adapter[]> {
  const runtime = await runtimeAdapter(plan);
  return [fleetAdapter(), filesAdapter, providerConfigAdapter(), runtime, jobsAdapter({ tasks: runtime.tasks }), identityAdapter()];
}
