import Sidebar from "../components/Sidebar";
import CBBanner from "../components/CBBanner";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CBBanner />
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar />
        <main style={{ flex: 1, overflow: "auto" }}>
          {children}
        </main>
      </div>
    </>
  );
}
