import { DeviceCard } from "./DeviceCard.js";
import { RepoCard } from "./RepoCard.js";
import { TraceCard } from "./TraceCard.js";

export function UtilityRail(): JSX.Element {
  return (
    <aside className="utility-rail" data-testid="utility-rail">
      <DeviceCard />
      {/* The workspace's repository, under the device (ADR 0058) — present
          whenever the workspace is a repository. */}
      <RepoCard />
      {/* What 板砖 is doing, in phases, with the live pane under the step in
          flight (ADR 0073) — present while a dispatch works, and for a beat
          after it settles. */}
      <TraceCard />
    </aside>
  );
}
