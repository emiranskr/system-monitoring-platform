import { Route, Routes } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { RequireAuth } from "./session/RequireAuth";

/** Yonlendirme tablosu. Saglayicilar (QueryClient, Router, Session) main.tsx'te / testlerde dissaldan verilir. */
export function App() {
  return (
    <Routes>
      <Route path="/giris" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><main className="p-6"><h1 className="text-xl font-semibold">Sistem İzleme</h1></main></RequireAuth>} />
      <Route path="*" element={<main className="p-6"><h1 className="text-xl font-semibold">Sayfa bulunamadı</h1></main>} />
    </Routes>
  );
}
