import { requireMember } from "@/lib/session";
import { Nav } from "@/components/nav";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, teamName, role } = await requireMember();

  return (
    <>
      <Nav teamName={teamName} user={user} role={role} />
      <main className="flex-1 w-full px-6 py-8">{children}</main>
    </>
  );
}
