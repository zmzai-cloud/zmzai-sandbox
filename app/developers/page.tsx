import { redirect } from "next/navigation";

// 开发者工作台已拆分为 /keys 与 /docs，旧链接保持可达
export default function DevelopersPage() {
  redirect("/keys");
}
