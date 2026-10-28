# TradingAgents 本地桌面

这是调用独立 `TradingAgents` 官方源码的 Windows Electron 启动器。在“API 设置”中添加模型连接，然后选择连接、标的与日期开始分析。通用兼容接口需要填写完整 API 地址和模型名称；高级选项可使用官方支持且以 API key 认证的供应商代码。所选模型需支持官方分析流程的工具调用；可用性取决于服务提供商。

## 安装与启动

需要 Windows、Git、Python 3.11 或更新版本以及 Node.js 22.12 或更新版本。以下示例在 PowerShell 中执行，桌面代码和官方代码分别放在同一个父目录下：

```powershell
git clone https://github.com/lizhuoh9/TradingAgents.git TradingAgents-Desktop-Project
git clone https://github.com/TauricResearch/TradingAgents.git TradingAgents
cd TradingAgents
py -3.11 -m venv .venv-win
.\.venv-win\Scripts\python.exe -m pip install -e .
cd ..\TradingAgents-Desktop-Project\desktop
npm ci
npm start
```

安装后也可双击本目录的 `启动桌面版.cmd`。桌面程序会查找同级的独立 `TradingAgents` 官方目录；若官方源码放在其他位置，可在启动前设置 `TRADINGAGENTS_SOURCE_DIR` 为其绝对路径。不要把本 fork 自身当作官方更新目标：独立目录能保持官方 `main` 的快进更新。使用自己 fork 的其他人可将第一条 clone 地址替换为自己的仓库地址。

## 测试

在 `desktop` 目录执行 `npm test`。Python 检查可用官方虚拟环境执行 `..\..\TradingAgents\.venv-win\Scripts\python.exe -m unittest test_model_catalog test_memory_transaction test_fred_guard`。界面端到端测试为维护者可选检查：安装 Playwright（`npm install --no-save playwright` 和 `npx playwright install chromium`）后运行 `node reader.e2e.cjs`、`node rating-ui.e2e.cjs`、`node report-groups.e2e.cjs` 、`node model-ui.e2e.cjs`、`node fred-ui.e2e.cjs`、`node ticker-ui.e2e.cjs` 和 `node watchlist-ui.e2e.cjs`。`node connection.e2e.cjs` 和 `node watchlist-electron.e2e.cjs` 启动隔离的 Electron 和本机模拟接口，在 Windows 上创建目录联接可能需要开发者模式或相应权限。浏览器测试可通过 `READER_BROWSER_EXECUTABLE` 或 `MODEL_UI_BROWSER_EXECUTABLE` 指定本机浏览器。

编辑连接时可从本机安装的官方模型目录中选择，或手动输入其他模型 ID。本地目录不会访问网络，也不代表账户权限。点击“测试连接并获取模型”后，程序会向所选兼容接口的模型列表地址发送鉴权密钥并读取结果；不会发送股票、报告或历史记录，但服务可看到连接信息。为保护密钥，测试不会跟随重定向。非兼容协议如果不支持该测试，可使用本地目录或手动填写。通用兼容地址若与官方项目登记的某个 HTTPS 服务地址及标准路径精确匹配，分析时使用对应的官方客户端；连接地址和密钥保持不变。其他地址继续使用通用客户端。

中国内地及其他六位数字股票代码需要填写交易所后缀，如沪市 `600172.SS`、深市 `000001.SZ`；请先确认交易所。能否取得行情或新闻仍取决于数据源的覆盖与网络。

API 设置中的“可选数据服务”支持保存用户自行申请的 FRED 密钥；密钥由 Windows 加密保存在本机，仅在分析时用于 FRED 宏观数据请求。未配置时宏观数据可能缺失；Polymarket 连接重置属于网络问题，配置 FRED 密钥不会解决。

连接配置由 Electron 的系统加密接口保存到 `local-data/api-profiles.bin`，仅在本机当前 Windows 用户环境下使用。保存密钥时请勿将这个目录加入 Git；若系统加密服务不可用，程序会拒绝保存。接口地址不能包含用户名、密码或查询参数；云端接口必须使用 HTTPS，本机接口可使用 HTTP。更改已保存密钥的服务或地址时需要重新输入密钥。

若连接文件无法解密，先确认使用了保存时的 Windows 登录账户。设置页可由用户主动选择“备份原配置并重新配置”：程序会保留原始加密文件的本地备份，新连接需要重新填写密钥；不会自动删除或替换旧文件。

“更新官方项目”只更新独立的官方 Python 源码及依赖，不会更新桌面端代码。它会检查源码的 origin 和 main 分支，然后执行 fast-forward 更新与 Python 依赖安装。检测到已跟踪文件修改时会停止。更新过程中出现错误或中断后，分析会被暂时禁用，请检查日志和网络后再次点击更新。更新并非原子回滚，官方后续版本若修改命令行接口，桌面程序可能需要跟着调整。桌面端更新需在桌面代码仓库单独拉取并按需运行 `npm ci`。

报告和运行日志按 `desktop/local-data/analysis/logs/<分析日期>/<代码>/run-<运行时间>-<标识>/` 保存；每次运行都有独立目录。缓存、CLI 偏好和决策历史也保存在 `desktop/local-data/analysis/`，该目录由桌面项目的 `.gitignore` 排除。旧版本位于独立官方仓库的 `local-data/` 的资料不会自动迁移；如需迁移，请先备份，再手动复制到新目录。可在“报告阅读”页查看已保存报告，或打开文件夹查看原始文件。

CLI 偏好位置通过当前官方版本的内部接口指定；若上游更新改变该接口，分析会停止并提示更新桌面程序，避免悄悄改回其他保存位置。

分析进行时可在运行日志处点击“停止分析”。程序只停止当前分析的 Windows 任务组，不停止官方更新；已发送给服务的请求无法撤回。中断时保留运行目录、已有日志与未完成报告，但未完成报告不会列入完整报告库。共享决策历史在运行期间使用独立副本，只有分析自然结束、报告存在且共享历史未被其他程序更改后才原子提交；冲突或提交失败时保留本次副本和未完成标记，不覆盖共享历史。

报告阅读器在本机按常见 Markdown 结构排版，支持标题、粗体、列表、引用、代码和常见表格。为避免改变财务表达式，单星号内容与无法安全识别的复杂结构保留原文；报告内的外部链接和图片不会自动访问网络。

“自选”保存在本机 `local-data/watchlist.json`。首次使用时会从已有完整报告的代码初始化；可以添加或移除标的。批量分析按顺序逐只调用所选模型和行情服务，可能产生 API 费用；停止批次会停止当前任务并取消尚未开始的任务，已经完成的报告保留。每只股票显示的是报告中的最终评级，而非保证收益。

“A 股热门候选”由用户点击后读取东方财富公开延迟行情和财务摘要；东方财富行情不可用时会使用腾讯公开行情，并继续核验东方财富财报，不上传自选、API 密钥或报告。筛选按成交额排序，最多核查 20 只符合条件的沪深股票，并要求最近已公告财报中的归母净利润为正；缺少财报的标的排除。它并非完整 A 股筛选或人气榜，历史盈利不预测未来收益。接口不可用时会显示错误或明确标注近期本地缓存、行情日期及数据时效；公开数据源可能限流或变更。

分析采用官方联网流程：行情服务可能收到标的、查询日期及连接信息；所选模型服务可能收到标的、日期、分析上下文和本程序此前决策的相关内容。桌面程序关闭继承的 LangChain/LangSmith 追踪配置，不会自动沿用环境中的额外行情服务密钥或 SEC 联系信息，因此需要密钥的可选数据源可能不可用。股票分析包含行情、新闻和基本面；加密资产分析包含行情和新闻。运行依赖有效的模型连接、账户额度和数据源可用性。

界面使用 [open-claude-ui](https://github.com/Caho1/open-claude-ui) 的 `cds-theme.css` 和 `cds-pure.css`（参考版本 `c1f923a`）；许可见 [vendor/LICENSE-open-claude-ui](vendor/LICENSE-open-claude-ui)。

图标来自官方 TradingAgents 仓库的 `tradingagents/assets/tauric-logo.svg`；`assets/` 中保留原始 SVG 和裁切视口后的图标。

桌面界面采用紧凑侧栏和统一工作区布局。顶栏按钮可收起侧栏；运行日志支持“自动换行”和“跟随最新”，向上滚动会暂停跟随，点击按钮可恢复。宽屏下日期报告目录与正文独立滚动，切换报告会回到顶部的最终建议；较窄窗口自动改为上下布局。市场页优先展示 A 股候选筛选，下方提供代码速查；API 设置按连接信息和分析模型分组。

界面布局参考 [open-claude-ui](https://github.com/Caho1/open-claude-ui) 的本地设计令牌、[Linear 的界面层级说明](https://linear.app/now/behind-the-latest-design-refresh)和 [Notion 的侧栏组织方式](https://www.notion.com/help/navigate-with-the-sidebar)。没有新增在线字体、远程界面资源或遥测。`workspace-ui.e2e.cjs` 使用独立模拟数据检查五个页面的响应布局、侧栏、日志跟随和报告切换，截图默认写入忽略提交的 `local-data/ui-review/`；需本机 Playwright 和 Chromium，通过 `NODE_PATH` 与 `READER_BROWSER_EXECUTABLE` 指定现有运行环境。
