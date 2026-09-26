# ChatGPT Science

開發中的獨立 Windows 科研工作台，使用真正的 ChatGPT 帳號、自己的研究服務與資料目錄。目標是在保留參考工作台 UI／UX 的前提下，支援對話、程式實驗、成果版本、批註、研究技能與連接器。這不是 OpenAI 或 Anthropic 官方發行的產品。

**目前公開的是未完成的原始碼快照，不是正式版 EXE，也尚未達到完整功能對齊。** 請先讀 [交接與未完成項目](docs/HANDOFF.md)。

## 兩條路線

這個 repository 現在有兩種做法，目標不同，不共用程式碼。

**`bridge/` — 只改接口。** 直接執行原版 Claude Science，只把推論端點指向本機轉接服務，其餘一律不動：不修改可執行檔、不改編譯介面、不重寫後端服務。原版的 kernel、成果版本、連接器、技能與檢視器因為就是原版，所以本來就能用。作法與已查明的限制見 [接口重導](docs/INTERFACE-ONLY.md)。注意原版強制要求 Claude 登入，這條路線不移除該要求，只改推論去向。

**其餘目錄 — 獨立應用。** 自建 Electron shell、Node 服務與 worker，配合本機提供的參考介面。這條路線要重做原版的整個後端；[HANDOFF](docs/HANDOFF.md) 列出尚未完成的部分，其中 `server/reference-artifacts.mjs` 仍未撰寫。

兩者都尚未通過端到端驗收。

## 公開範圍

Repository 包含自行開發的 Electron shell、Node 服務、ChatGPT bridge、Python／R worker、介面協定 adapters、測試及建置腳本。原版 Claude Science 的可執行檔、編譯介面、字型與其他資源不在此 repository；研究資料、登入憑證、瀏覽器設定、runtime、測試輸出和舊 EXE 也不會上傳。

`reference-ui/` 是本機提供的外部資源，不會由 npm 自動取得。準備器僅接受指定版本與 hash 的本機靜態副本。未提供這些資源時，不能從這份公開 source checkout 建出所要求的原版介面成品。

## 目前實作

`server/index.mjs` 管理專案、對話、工具核准、kernel、成果與外部整合；`server/codex-bridge.mjs` 透過 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 管理 ChatGPT 登入、模型和串流推理。`worker/kernel_worker.py` 執行持久 Python／R kernels，保存實際程式、輸出、錯誤與成果來源。

`server/reference-*.mjs` 將參考介面的請求轉成自有服務。部分路由尚未完成或尚未掛載；原有 `web/` 是早期實驗介面，不是已完成的目標 UI。

## 登入、權限與資料

需要已安裝的 Codex CLI 與可用的 managed ChatGPT 登入；必要時透過 `SCIENCE_CODEX_PATH` 指定原生 codex.exe。應用只接受 ChatGPT account type，不把 API key 模式當成 ChatGPT 訂閱登入，也不複製 Claude 憑證。

「Disconnect ChatGPT」只中斷本應用自己的連線，不會登出共享 Codex 帳號。帳號、模型及用量以服務當時的真實回應為準。服務與介面會檢查本機 session、origin 和 CSRF；模型只能使用應用提供的研究工具。

Python／R 目前以使用者的主機權限執行，**不是 OS sandbox**。必須在專案明確啟用 `allowHostExecution` 才能執行。連接器、雲端運算和儲存需要各自有效的設定與授權；不要把未配置的外部服務當成已驗證。

桌面資料預設保存在應用旁的 `ChatGPTScienceData/research-data/`，可用 `SCIENCE_DATA_HOME` 改變桌面資料根目錄。CLI 預設使用 `data/`。資料目錄和所有憑證都不應 commit。

## 開發與測試

本機開發已使用 Node.js 24 與 npm；依賴版本見 lockfile。

```powershell
npm ci
node --test tests/bridge.test.mjs tests/integrations.test.mjs tests/reference-chat.test.mjs tests/reference-ui.test.mjs
```

完整 `npm test` 包含真正的 Python／R kernel 測試，需先依 [runtime 文件](worker/RUNTIME.md) 配置本機科學環境。Windows 提供 `worker/setup-python.ps1` 與 `worker/setup-r.ps1`；它們會下載／建立應用專用 runtime，先確認所需工具和磁碟空間。部分整合測試會在系統暫存或 checkout 外的 work 目錄建立獨立 fixture。

2026-09-26 發布前，本機完整測試為 104 passed、0 failed。這不等於原版 UI、完整功能或 EXE 已通過驗收。

`scripts/verify-live.mjs --run-live` 是額外的真 ChatGPT 研究工具測試，會使用已登入帳號的額度，不屬於一般單元測試。不要把測試資料或帳號資訊加入 repository。

## 保留參考介面的本機建置

先在本機提供可使用的 0.1.50 web-dist 靜態副本。不要指向正在執行的原應用資料目錄，也不要複製其帳號或研究資料。

```powershell
node scripts/prepare-reference-ui.mjs 'C:\local-reference\web-dist'
```

此命令核對來源 hash，產生被 Git 忽略的 reference-ui。目前 package:win 仍使用開發工作區預設的外部副本路徑；一般 checkout 可在完成資源準備與 runtime 配置後直接執行打包器：

```powershell
npm exec electron-builder -- --win portable --publish never
```

目標檔名為 ChatGPT-Science-0.1.1-Windows.exe。**目前未提供通過完整驗收的 release 或 EXE。** 打包成功也不代表所有參考功能已經實作；需另做原生啟動、登入、對話、檔案與運算流程驗證。

`npm run build` 只建置早期的實驗前端，不代表完成目標 UI。參考介面整合、尚未接線的模組和完整驗收要求請見 [HANDOFF](docs/HANDOFF.md)。
