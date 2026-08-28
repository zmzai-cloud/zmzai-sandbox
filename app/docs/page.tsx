import { ApiDocs } from "@/components/api-docs";
import { SandboxShell } from "@/components/sandbox-shell";

export const metadata = { title: "API 文档 · Sandbox" };

export default function DocsPage() {
  return (
    <SandboxShell>
      <ApiDocs />
    </SandboxShell>
  );
}
