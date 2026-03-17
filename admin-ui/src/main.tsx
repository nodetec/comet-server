import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Routes, Route } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "@/hooks/use-theme"
import { AppLayout } from "@/components/app-layout"
import { LoginPage } from "@/pages/login"
import { DashboardPage } from "@/pages/dashboard"
import { EventsPage } from "@/pages/events"
import { BlobsPage } from "@/pages/blobs"
import { AllowlistPage } from "@/pages/allowlist"
import { ConnectionsPage } from "@/pages/connections"
import { UsersPage } from "@/pages/users"
import { InviteCodesPage } from "@/pages/invite-codes"
import "./index.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5000,
    },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/admin/login" element={<LoginPage />} />
            <Route element={<AppLayout />}>
              <Route path="/admin" element={<DashboardPage />} />
              <Route path="/admin/events" element={<EventsPage />} />
              <Route path="/admin/blobs" element={<BlobsPage />} />
              <Route path="/admin/allowlist" element={<AllowlistPage />} />
              <Route path="/admin/invite-codes" element={<InviteCodesPage />} />
              <Route path="/admin/connections" element={<ConnectionsPage />} />
              <Route path="/admin/users" element={<UsersPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
