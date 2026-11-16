import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initI18n, t } from "@/i18n";
import "./index.css";

// Resolve the UI language and load its catalogs before importing App: many modules build label tables
// with t() at module load, so App (and everything it imports) must load after the catalogs are ready.
// initI18n never rejects (an unreadable catalog only leaves those strings in the source language).
async function start(container: HTMLElement): Promise<void> {
  await initI18n();
  const { App } = await import("@/app/App");
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

const container = document.getElementById("root");
if (!container) throw new Error(t("找不到 #root 容器"));

start(container).catch((error: unknown) => {
  // 載入主程式失敗（例如部署中途、網路中斷）：不要停在空白的載入畫面
  console.error(error);
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.className = "ps-boot";
  message.textContent = t("介面載入失敗：{message}。請重新整理頁面。", { message: error instanceof Error ? error.message : String(error) });
  container.replaceChildren(message);
});
