export default function MainLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-dvh min-h-0 flex-col">{children}</div>;
}
