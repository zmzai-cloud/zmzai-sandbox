import { ConsoleView } from "@/components/console-view";
import { SandboxShell } from "@/components/sandbox-shell";

export default function HomePage() {
  return (
    <SandboxShell>
      <ConsoleView mode="task" />
    </SandboxShell>
  );
}
