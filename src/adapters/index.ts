import { filesAdapter, type Adapter } from "../reconciler/apply.ts";
import { fleetAdapter } from "./fleet/adapter.ts";
import { identityAdapter } from "./identity/adapter.ts";
import { jobsAdapter } from "./jobs/adapter.ts";
import { providerConfigAdapter } from "./provider-config/adapter.ts";
import { t3Adapter } from "./t3/adapter.ts";

export function engineAdapters(): Adapter[] {
  const t3 = t3Adapter();
  return [fleetAdapter(), filesAdapter, providerConfigAdapter(), t3, jobsAdapter({ t3: t3.tasks }), identityAdapter()];
}
