import { useState } from "react"
import { NavLink, Outlet, useNavigate } from "react-router"
import {
  LayoutDashboard,
  Shield,
  HardDrive,
  FileText,
  Wifi,
  Users,
  Ticket,
  LogOut,
  Orbit,
  Menu,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet"
import { ThemeToggle } from "@/components/theme-toggle"
import { logout } from "@/lib/api"
import { cn } from "@/lib/utils"

const navItems = [
  { to: "/admin", icon: LayoutDashboard, label: "Dashboard", end: true },
  { to: "/admin/events", icon: FileText, label: "Events" },
  { to: "/admin/blobs", icon: HardDrive, label: "Blobs" },
  { to: "/admin/allowlist", icon: Shield, label: "Allowlist" },
  { to: "/admin/users", icon: Users, label: "Users" },
  { to: "/admin/invite-codes", icon: Ticket, label: "Invite Codes" },
  { to: "/admin/connections", icon: Wifi, label: "Connections" },
]

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate("/admin/login")
  }

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-5">
        <Orbit className="h-5 w-5 text-sidebar-primary" />
        <span className="text-sm font-semibold text-sidebar-foreground">
          Comet Admin
        </span>
      </div>
      <Separator className="bg-sidebar-border" />
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Separator className="bg-sidebar-border" />
      <div className="flex items-center justify-between p-2">
        <ThemeToggle />
        <Button
          variant="ghost"
          size="icon"
          onClick={handleLogout}
          title="Logout"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </>
  )
}

export function AppLayout() {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <SidebarContent />
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="flex items-center gap-2 border-b border-border bg-background px-4 py-3 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-56 p-0 bg-sidebar">
              <SidebarContent onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <Orbit className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Comet Admin</span>
        </header>

        <main className="flex-1 overflow-auto bg-background">
          <div className="mx-auto max-w-5xl p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
