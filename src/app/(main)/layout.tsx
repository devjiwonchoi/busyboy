import { AppShell } from "@/components/shell/app-shell";

export default function MainLayout({
  children,
  panel,
}: {
  children: React.ReactNode;
  panel: React.ReactNode;
}) {
  return <AppShell panel={panel}>{children}</AppShell>;
}
