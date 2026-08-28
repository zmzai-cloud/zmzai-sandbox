import { KeysManager } from "@/components/keys-manager";
import { SandboxShell } from "@/components/sandbox-shell";

export const metadata = { title: "API 密钥 · Sandbox" };

export default function KeysPage() {
  return (
    <SandboxShell>
      <KeysManager />
    </SandboxShell>
  );
}
