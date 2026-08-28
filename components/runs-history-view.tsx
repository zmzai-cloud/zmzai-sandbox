"use client";

import { useSearchParams } from "next/navigation";

import { ConsoleView } from "@/components/console-view";

/**
 * 历史页入口：读取 ?run= 查询参数后交给 ConsoleView。
 * 单独拆出是为了让 useSearchParams 的 CSR bailout 只影响 /runs，首页可完整 SSR。
 */
export function RunsHistoryView() {
  const initialRunId = useSearchParams().get("run");
  return <ConsoleView mode="history" initialRunId={initialRunId} />;
}
