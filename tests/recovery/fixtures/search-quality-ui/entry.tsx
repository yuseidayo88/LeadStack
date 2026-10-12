import { createRoot } from "react-dom/client";
import DiscoverCompanies from "@/app/(workspace)/discover/page";
import "@/app/globals.css";

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-7xl space-y-4 p-4">
    <DiscoverCompanies />
  </main>,
);
