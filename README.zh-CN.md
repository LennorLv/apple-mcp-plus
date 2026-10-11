# Apple MCP Plus

[English](README.md) · [简体中文](README.zh-CN.md)

本地 macOS MCP 服务，支持 **联系人、备忘录、消息、邮件、提醒事项、日历**。共有 6 个 MCP 工具、42 个方法行为（包含诊断）。地图及其桌面模拟操作已经移除。

## 项目来源与持续维护

本项目来源于 [supermemoryai/apple-mcp](https://github.com/supermemoryai/apple-mcp)，原作者为 [Dhravya Shah](https://github.com/dhravya) 和 supermemory 团队。原仓库已于 2026 年 1 月 1 日归档。为满足自用需要，并在原项目归档后持续修复和维护，我们另建 Apple MCP Plus 独立仓库。

保留原有 MIT 许可证和版权声明，来源详情见 [PROJECT_ORIGIN.md](PROJECT_ORIGIN.md)。感谢原作者及贡献者的开源分享。

## 工具与方法列表

通过 MCP `tools/list` 获取参数定义，通过 `tools/call` 调用。多数工具用 `arguments.operation` 选择方法。联系人不传 `name` 时列出，传 `name` 时搜索；这里的 list/search 是行为名称，不是联系人接受的 operation 值。

| MCP 工具 | 查询方法 | 写入／发送方法 | 打开／授权方法 | 诊断 | 行为数 |
| --- | --- | --- | --- | --- | ---: |
| `contacts` 联系人 | 不传 `name` 列出；传 `name` 搜索 | — | — | `status`、`diagnose` | 4 |
| `notes` 备忘录 | `list`、`search`、`todos` | `create` | — | `status`、`diagnose` | 6 |
| `messages` 消息 | `read`、`unread` | `send`、`schedule` | — | `status`、`diagnose` | 6 |
| `mail` 邮件 | `accounts`、`mailboxes`、`latest`、`unread`、`search` | `send` | — | `status`、`diagnose` | 8 |
| `reminders` 提醒事项 | `list`、`search`、`listById`、`lists` | `create` | `open`、`authorize` | `status`、`diagnose` | 9 |
| `calendar` 日历 | `list`、`search`、`calendars`、`getById` | `create` | `open`、`authorize` | `status`、`diagnose` | 9 |
| **合计** | | | | | **42** |

- **联系人：** 列出／搜索真实联系人及全部电话号码，保留无号码联系人，显示结果中合并重复号码。
- **备忘录：** 列出最近笔记、按标题和正文搜索、按文件夹和日期筛选、按创建／修改时间排序；`todos` 读取未勾选的原生清单及文本待办标记；`create` 创建笔记。兼容原项目的默认目标文件夹为 `Claude`，仅 `Claude`／`Test-Claude` 可自动创建。
- **消息：** `read` 读取指定会话，`unread` 读取入站未读；`send` 提交 iMessage，`schedule` 在当前进程内定时提交。
- **邮件：** 枚举账号和邮箱，读取最近／未读邮件，搜索主题或主题加正文，发送可带 CC／BCC 的文本邮件。当前接口未实现附件发送或定时邮件。
- **提醒事项：** 列出／搜索，按实际完成状态筛选，按清单 ID 读取并可选返回字段；`lists` 枚举原生清单、来源 ID 和可写标记；`create` 写入名称、备注、截止日期；`open` 在应用中展示匹配事项；`authorize` 显式请求 EventKit 权限。
- **日历：** 按日期和日历列出／搜索，枚举原生日历，`getById` 读取原生事件或重复事件实例；`create` 创建普通／全天事件并写入地点和备注；`open` 展示事件；`authorize` 显式请求 EventKit 权限。
- **所有工具：** `status` 与 `diagnose` 检查有效权限，不启动目标应用、不主动请求授权，目前返回同样的诊断结构。

当前没有暴露删除、更新、勾选切换、附件发送或地图方法。

## 从源码安装与运行

需要 macOS 14+、Node.js、Bun 和 Xcode Command Line Tools，并可执行系统 `osascript`、`sqlite3`。服务通过本地 stdio 通信，不支持 Windows／Linux。

```sh
git clone https://github.com/LennorLv/apple-mcp-plus.git
cd apple-mcp-plus
bun install --frozen-lockfile
npm run build
npm start
```

构建生成 `dist/index.js` 和针对当前 Mac 架构进行 ad-hoc 签名的 EventKit helper。`npm run build:native` 只重建 helper。`npm start` 启动后等待标准输入上的 MCP 请求，需要 MCP 客户端交互。本项目尚未发布 npm 包。

客户端 MCP 配置示例，路径请替换为本机绝对路径：

```json
{
  "mcpServers": {
    "apple-mcp-plus": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/apple-mcp-plus/dist/index.js"]
    }
  }
}
```

通过 `command -v node` 获取 Node 路径。修改配置后重新连接／重启客户端；仅使用 Plus 时停用旧 `apple-mcp` 配置。原项目 npm 包和旧安装包并不包含这个版本。

## 权限与桌面影响

| 调用路径 | 权限与行为 |
| --- | --- |
| 联系人、备忘录、邮件；旧提醒事项／日历；消息发送 | 目标应用的 macOS 自动化／Apple Events 权限，相关应用需配置账号 |
| 消息 `read`／`unread` | 本地 Messages 数据库读取权限，通常需要完全磁盘访问权限 |
| 备忘录原生勾选状态 | 自动化读取笔记元数据，以及本地 Notes 数据库读取权限，通常需要完全磁盘访问权限 |
| 提醒事项／日历 `backend: "eventkit"` | 独立 EventKit 完全访问权限，通过 `authorize` 显式申请 |
| `reminders.open`、`calendar.open` | 激活应用并展示目标事项／事件 |
| `mail.send` | 创建可见写信窗口再发送 |

macOS 授权弹窗可能显示责任宿主（例如 ChatGPT、Codex、终端），而不是脚本文件名。应给实际运行宿主授权；更改完全磁盘访问后可能需要重启宿主。自动化和 EventKit 是两套独立权限。

运行代码没有鼠标模拟或辅助功能控件操作；诊断中的 `AXIsProcessTrusted` 仅查询权限状态。数据查询使用应用脚本、只读数据库或 EventKit。打开方法和邮件发送仍可能显示应用窗口。

**锁屏兼容性尚未完整验证。** 授权弹窗需要解锁处理。后台读取依赖已登录会话、进程存活、有效权限和本地数据；打开界面需要解锁桌面；整机睡眠可能推迟定时任务。

## 调用示例

以下对象是 MCP `tools/call` 的参数：

```json
{"name":"notes","arguments":{"operation":"list","limit":3,"sortBy":"modificationDate","sortOrder":"desc"}}
{"name":"notes","arguments":{"operation":"todos","limit":10}}
{"name":"mail","arguments":{"operation":"latest","limit":3}}
{"name":"contacts","arguments":{"name":"示例"}}
{"name":"reminders","arguments":{"operation":"list","backend":"eventkit","completed":false,"limit":10}}
{"name":"calendar","arguments":{"operation":"calendars"}}
{"name":"notes","arguments":{"operation":"status"}}
```

查询“昨天的发票邮件”时，传实际本地日的边界和时区，而不是滚动 24 小时：

```json
{"name":"mail","arguments":{"operation":"search","searchTerm":"发票","searchIn":"all","fromDate":"2026-10-10T00:00:00+08:00","toDate":"2026-10-11T00:00:00+08:00","mailbox":"inbox","limit":10}}
```

日期仅为示例，使用时替换为目标日期。`latest`／`unread` 默认查询收件箱，`search` 默认所有邮箱。正文搜索最多扫描 100 条主题未匹配的邮件／10 秒，超过预算应缩小邮箱或日期范围。

## EventKit 后端与已知限制

提醒事项／日历原有 `list`、`search` 默认走 **JXA**，原生读取需要显式传 `backend: "eventkit"`。`lists`、`calendars`、`getById`、`authorize` 仅支持原生后端，默认 EventKit。查询不会自动请求权限，也不会在失败时偷偷切换后端。

```json
{"name":"reminders","arguments":{"operation":"authorize","backend":"eventkit"}}
{"name":"calendar","arguments":{"operation":"authorize","backend":"eventkit"}}
{"name":"reminders","arguments":{"operation":"lists"}}
{"name":"reminders","arguments":{"operation":"listById","backend":"eventkit","listId":"EXACT_NATIVE_LIST_ID","limit":10}}
{"name":"calendar","arguments":{"operation":"list","backend":"eventkit","calendarId":"EXACT_NATIVE_CALENDAR_ID","fromDate":"2026-10-11T00:00:00+08:00","toDate":"2026-10-12T00:00:00+08:00","limit":10}}
```

- `idType` 标记原生和脚本 ID，**不能混用**。创建／打开仍走 JXA，原生后端的写入／打开请求会被拒绝。
- 重复事件的原生 `getById` 需要 `occurrenceDate`。日历范围采用半开区间 `[fromDate,toDate)`，包含与范围重叠的事件；EventKit 最多查询 366 天。同名容器有歧义时明确报错，应使用对应后端的准确 ID。
- 查询元数据报告后端、完整性和截断。正常空结果与权限、超时、数据错误有区别。helper 超时会取消未完成读取，下一次显式请求可重新启动 helper。
- 原生提醒事项按 ID 排序，JXA 按应用顺序。`alarmDate` 表示最早绝对提醒时间；兼容字段 `remindMeDate` 可能回退到截止日期，不能证明已配置通知。
- 大型 JXA 提醒事项集合在本机曾出现超时；这类查询建议显式使用 EventKit。不要把超时当成没有事项。
- 原生备忘录清单使用私有数据库格式，读取本地已保存版本，不同 macOS 版本可能变化。未保存编辑、锁定笔记、同步延迟或不支持的数据可能导致状态不可用。应检查 `nativeChecklistStatus`、`unavailableNotes`；零匹配不能单独证明没有待办。文本 TODO 关键词属于未验证项。
- 消息定时发送采用进程内计时器，最多 24.8 天；重启 MCP 会取消，睡眠可能推迟；提交成功不等于接收端送达。

## 验证与开发

```sh
npm run build
npm test
npm run test:plan
node_modules/.bin/tsc --noEmit
npm run test:eventkit
```

默认测试使用合成应用模拟和实际 Node／Bun stdio 清单核验，不读取或修改个人应用数据。测试方案校验覆盖全部 42 个行为和 190 个必测变体；**方案覆盖不等于功能已实测通过**。

在已授权的 Mac 上可选择运行真实只读检查：

```sh
npm run verify:readonly
npm run verify:readonly:bun
```

脚本只查询应用和数据库，不写入、不发送、不打开目标、不申请 EventKit 授权；自动化查询若尚未授权，系统仍可能弹窗。可用 `APPLE_MCP_TEST_HANDLE` 指定消息读取的测试会话。过程记录在被忽略的 `.cache/verification/`，仅保存摘要哈希、数量和状态，不保存个人正文。没有合适事件／容器或测试会话时标记跳过；原生清单解码不完整时标记部分通过。

详见 [验证记录](VERIFICATION.zh-CN.md) 和 [测试说明](TEST_README.md)。服务已在本机检查，但不表示每个边界、每台 Mac、每个锁屏路径均已通过。本机真实数据验收记录和此前 Git 历史保留在公开提交之外。

## 致谢与许可证

感谢 **Dhravya Shah**、**supermemory 团队**及[原 Apple MCP 项目](https://github.com/supermemoryai/apple-mcp)的所有贡献者，他们的工作为本项目提供了基础。

采用 [MIT 许可证](LICENSE)，保留原始 `Copyright (c) 2025 Dhravya Shah` 声明。
