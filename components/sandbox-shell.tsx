"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { AppShell as ThemeAppShell, AppShellAccountRow, Button } from "@zmzai/theme";
import type { AppNavSection, AppPaletteItem, IconName } from "@zmzai/theme";

type SessionUser = { id: string; name: string; email: string };
type RunSummary = { id: string; task: string; status: string; createdAt: string };

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL ?? "https://auth.zmzai.cloud";
const baseUrl = "https://z.zmzai.cloud";

const activeStatuses = ["queued", "planning", "running", "cancellation_requested", "cleanup_pending"];

const sections: AppNavSection[] = [
  {
    label: "执行",
    items: [
      { label: "任务", href: "/", icon: "play" as IconName, keywords: "run task 提交" },
      { label: "运行历史", href: "/runs", icon: "clock" as IconName, keywords: "runs history 归档" },
    ],
  },
  {
    label: "开发者",
    items: [
      { label: "API 密钥", href: "/keys", icon: "key" as IconName, keywords: "keys token sandbox_key" },
      { label: "API 文档", href: "/docs", icon: "book" as IconName, keywords: "docs api quickstart" },
    ],
  },
];

/**
 * sandbox 站点装配层 — theme AppShell 的薄封装。
 * 站点信息（导航分组/品牌/会话/⌘K 条目/并发数）在此注入，UI 结构由 @zmzai/theme 统一。
 */
export function SandboxShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/session", { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json()) as { user?: SessionUser };
        if (data.user) setUser(data.user);
      }
      setIsLoadingSession(false);
    })();
  }, []);

  // 登录后拉取运行摘要：驱动 ⌘K 历史搜索与顶栏并发数（切页时顺手刷新）
  useEffect(() => {
    if (!user) return;
    fetch("/api/runs", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { runs?: RunSummary[] } | null) => {
        if (data?.runs) setRuns(data.runs);
      })
      .catch(() => {});
  }, [user, pathname]);

  const activeCount = runs.filter((run) => activeStatuses.includes(run.status)).length;

  const paletteItems = useMemo<AppPaletteItem[]>(() => {
    const navItems: AppPaletteItem[] = sections.flatMap((section) =>
      section.items.map((item) => ({
        label: item.label,
        hint: section.label,
        group: "导航",
        icon: item.icon,
        keywords: item.keywords,
        run: () => router.push(item.href),
      })),
    );
    const runItems: AppPaletteItem[] = runs.slice(0, 12).map((run) => ({
      label: run.task,
      hint: "运行",
      group: "运行",
      icon: "arrow-right" as IconName,
      keywords: run.id,
      run: () => router.push(`/runs?run=${run.id}`),
    }));
    const actions: AppPaletteItem[] = [
      { label: "复制 API Base URL", hint: baseUrl, group: "动作", icon: "copy" as IconName, run: () => void navigator.clipboard?.writeText(baseUrl) },
    ];
    return [...navItems, ...runItems, ...actions];
  }, [runs, router]);

  const account = user ? (
    <AppShellAccountRow name={user.name}>
      <span className="truncate font-mono text-[11px] text-muted">{user.email}</span>
    </AppShellAccountRow>
  ) : (
    <div className="mt-auto border-t border-line px-2 pt-3">
      <a href={`${AUTH_URL}/login?next=${encodeURIComponent(`${baseUrl}/`)}`}>
        <Button size="sm" className="w-full">{isLoadingSession ? "检查登录…" : "登录"}</Button>
      </a>
    </div>
  );

  return (
    <ThemeAppShell
      brand={{ label: "sandbox", suffix: "· z.zmzai.cloud", href: "/" }}
      sections={sections}
      pathname={pathname}
      link={Link}
      account={account}
      headerExtras={user ? <span className="font-mono text-xs text-muted">并发 {activeCount}/1</span> : null}
      paletteItems={paletteItems}
    >
      {children}
    </ThemeAppShell>
  );
}
