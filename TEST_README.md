# Testing / 测试说明

The default suite does not access Apple apps. Build first, then run:

```sh
npm run build
npm test
npm run test:plan
node_modules/.bin/tsc --noEmit
npm run test:eventkit
```

- Query regressions mock app records and side effects, including create/open/send paths. A mocked send does not prove delivery.
- Notes checklist tests use synthetic gzip/protobuf data, including checked/unchecked, Chinese, emoji, malformed and unknown states.
- EventKit client tests exercise correlation, cancellation, deadlines, restarts and invalid responses with a fake helper. Native `--self-test` covers internal parsing/semantics without personal data.
- Inventory tests launch the actual Node bundle and Bun source, verify all six tools and reject all removed Maps calls. Node is found on PATH (or `APPLE_MCP_NODE`); Bun uses the running test executable.
- `test:plan` checks 42 declarative cases and 190 required variant items in `tests/acceptance/`. Every design case remains `NOT_RUN`; this command performs no functional app tests.

Optional `npm run verify:readonly` / `npm run verify:readonly:bun` checks effective permissions and representative real reads. It requires local app/database access. Existing Automation permissions are needed; macOS may otherwise show a prompt. It does not authorize EventKit, write app data, send messages or open targets. `APPLE_MCP_TEST_HANDLE` optionally selects a message conversation; no test number is embedded in source. Reports are ignored under `.cache/verification/` and exclude personal records, IDs and exception text. PASS confirms the stated assertion, PARTIAL marks unavailable native checklist states, SKIP means a required sample was absent, and FAIL marks a call/assertion failure.

Before testing writes or UI opening, create dedicated marked samples, record their exact IDs in a private local state file, verify independently and clean up only those IDs. Sending tests require a recipient you control and separate delivery confirmation. The public repository deliberately excludes historical real-data setup/cleanup/send runners and their logs.

See [English verification](VERIFICATION.md) / [中文验证记录](VERIFICATION.zh-CN.md).

---

默认回归不访问个人应用。包括查询／写入／打开／发送的合成模拟、备忘录清单格式解码、原生客户端超时和协议异常处理，以及实际 Node/Bun MCP 工具注册。模拟发送不代表实际送达。先构建，再按以上命令执行。

方案文件覆盖 42 个行为、190 个必测变体；`test:plan` 只校验方案，每条方案仍为 `NOT_RUN`，不能当作功能通过记录。

真实只读脚本需要本机应用／数据库权限，不申请 EventKit 权限、不写入、不发送、不打开目标；未授权的自动化查询仍可能触发系统弹窗。可通过环境变量 `APPLE_MCP_TEST_HANDLE` 指定测试会话，源码没有写死测试手机号。记录保存在忽略的 `.cache/verification/`，不保存个人记录、ID 和异常原文。PASS／PARTIAL／SKIP／FAIL 分别表示断言通过、原生清单部分不可读、缺少样本、调用或断言失败。

测试写入／打开时，先创建明确标记的专用样本，私下记录准确 ID，独立回读后只清理这些 ID。发送测试需受控接收端和送达确认。历史个人验收资料及 setup／cleanup／send 脚本不随公开版本发布。
