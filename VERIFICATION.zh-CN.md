# 验证记录

[English](VERIFICATION.md) · [简体中文](VERIFICATION.zh-CN.md)

核验日期：2026 年 10 月 11 日。测试环境为一台已授权的 macOS 27.0 arm64 机器，Node.js 24.21.0、Bun 1.4.3。最低构建目标为 macOS 14，本轮没有验证其他机器和较旧的支持版本。

## 可复现构建与合成回归

在只含公开源码的独立目录执行 `bun install --frozen-lockfile --ignore-scripts`，安装、构建、回归、类型检查、方案校验和原生自测均通过。

| 检查 | 实际结果 | 说明 |
| --- | --- | --- |
| 冻结依赖安装 | PASS | 从已提交锁文件全新安装 |
| Node bundle + 签名原生 helper 构建 | PASS | 本机源码可构建 |
| 默认回归 | 36 PASS、0 FAIL、175 个断言 | 合成查询／写入／打开／发送逻辑、清单解码、helper 协议 |
| Node／Bun 真实 stdio 清单 | PASS | 注册六个工具；两种运行方式各拒绝九种旧地图方法 |
| TypeScript `--noEmit` | PASS | 运行代码和测试类型检查通过 |
| 原生 helper `--self-test` | 4 PASS | 不访问个人应用的内部语义测试 |
| 方案校验 | 42 个行为、190 个必测变体 | 仅校验设计完整性，此命令实际功能测试数量为 0 |

最初检查发现原有 node_modules 与锁文件版本不同，已将当前依赖对齐全新冻结安装，并再次测试真实查询。冻结版本包括 MCP SDK 1.5.0、JXA 1.3.6、Zod 3.24.2、TypeScript 5.7.3。

## 实际 MCP 查询

通过 SDK／stdio 完成初始化、ping、工具发现，调用六个工具的 `status`／`diagnose` 和以下查询。本轮没有写入数据、发送内容、打开目标或申请 EventKit 授权。

| 工具 | 实测方法 | 结果 |
| --- | --- | --- |
| 联系人 | 列出、搜索、status、diagnose | PASS |
| 备忘录 | 最近三条并核对排序、search、todos、status、diagnose | todos 原生状态部分可用，其余 PASS |
| 消息 | 读取受控会话、unread、status、diagnose | PASS |
| 邮件 | accounts、mailboxes、latest、unread、主题搜索、status、diagnose | PASS |
| 提醒事项 | 原生 lists／list／search／listById、默认 JXA list、status、diagnose | PASS |
| 日历 | 原生 calendars／list／search／getById、默认 JXA list、status、diagnose | PASS |

冻结依赖下，Node、Bun 两种方式各为 **35 PASS、1 PARTIAL、0 FAIL、0 SKIP**。PASS 表示调用成功且该脚本断言成立；搜索返回正常空集只验证空分支，不能代替所有功能的非空匹配正例。

PARTIAL 来自 `notes.todos`：部分本地笔记数据返回“缺失、锁定或未同步”。数据库可读取、其他笔记可解码，尚未进一步确认该不可用记录的具体原因。服务明确返回 `nativeChecklistStatus: "partial"`，没有猜测勾选状态，因此不能把所有原生清单状态都记作通过。

此前本地验收包括受控备忘录／提醒事项／日历创建和打开、邮件接收、即时／定时 iMessage 送达，历史记录保留在本地。本次发布核验**没有重新执行写入、打开及发送**，此前结果不能代表冻结公开版本每项操作和边界均通过。

## 尚未覆盖的边界

- 190 个方案变体尚未全部执行，权限拒绝、特殊账号配置、同步竞态、重复事件例外等仍需补充验收。
- 尚未认证锁屏兼容性；打开界面和处理权限弹窗需要解锁。
- 此前大型 JXA 提醒事项集合出现过超时，可显式选择 EventKit 读取。本次仅测试有界 JXA 查询，没有重新做压力测试。
- Notes 私有数据库格式和本地快照受系统版本影响，不可用状态必须显式保留。
- 授权通过或发送已提交，不代表账号、同步和接收端送达正常。

## 复现与追溯

命令见 [TEST_README.md](TEST_README.md)。只读过程记录保存在忽略的 `.cache/verification/`。公开证据仅包含测试 ID／状态及源码摘要，不包含个人记录、地址、接收端 ID 或正文。公开 Git 历史从整理后的源码快照开始；旧本地 Git 历史及个人验收资料已私下备份。

运行源码 SHA-256：`4c567b4215c75fc56f9e3ce2aa3a87fd843224f1c66765e9a8abb965d4a6b7bd`。摘要按 `文件名 + "\n" + UTF-8 源码 + "\n"` 拼接，顺序为 `index.ts`、`tools.ts`、按文件名排序的全部 `utils/*.ts`、`native/EventKitHelper.swift`、`native/Info.plist`。依赖版本、平台和运行时属于额外前提。

六个工具的 MCP 服务在本机有效授权下可用；这不等于所有 42 个行为及边界均已完整验收，也不等于所有 Mac 和系统版本通用。

[Machine-readable summary / 机器可读摘要](verification/2026-10-11.json)
