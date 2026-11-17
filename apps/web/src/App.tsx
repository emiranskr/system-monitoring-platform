import type { ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DevicePage } from "./pages/DevicePage";
import { DevicesPage } from "./pages/DevicesPage";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RequireAuth } from "./session/RequireAuth";

const protectedPage = (page: ReactNode) => <RequireAuth><AppShell>{page}</AppShell></RequireAuth>;

/** Yonlendirme tablosu. Saglayicilar (QueryClient, Router, Session) main.tsx'te / testlerde dissaldan verilir. */
export function App() {
  return (
    <Routes>
      <Route path="/giris" element={<LoginPage />} />
      <Route path="/" element={protectedPage(<OverviewPage />)} />
      <Route path="/cihazlar" element={protectedPage(<DevicesPage />)} />
      <Route path="/cihaz/:id" element={protectedPage(<DevicePage />)} />
      <Route path="*" element={<main className="p-6"><h1 className="text-xl font-semibold">Sayfa bulunamadı</h1></main>} />
    </Routes>
  );
}
