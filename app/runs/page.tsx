import { Suspense } from "react";

import { RunsHistoryView } from "@/components/runs-history-view";
import { SandboxShell } from "@/components/sandbox-shell";

export const metadata = { title: "运行历史 · Sandbox" };

export default function RunsPage() {
  return (
    <SandboxShell>
      {/* RunsHistoryView 读取 ?run= 查询参数，需在 Suspense 内进行静态渲染 */}
      <Suspense fallback={null}>
        <RunsHistoryView />
      </Suspense>
    </SandboxShell>
  );
}
