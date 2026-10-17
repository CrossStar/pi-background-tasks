# pi-background-tasks

<p align="center">
  <img src="logo.png" alt="后台任务管理器" width="128">
</p>

这是我在 [CrossStar/pi-background-tasks](https://github.com/CrossStar/pi-background-tasks) 维护的 Pi 扩展。它把长时间运行的 shell 命令交给后台执行，让当前对话继续，同时提供一个可以查看进度、搜索日志、停止任务的终端监控台。

我的日常使用场景是运行测试、构建、Python 脚本和开发服务。普通任务只需要关注命令、状态和输出，因此默认界面不显示 model、ctx、token 等模型信息。

这个仓库基于 [ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) 继续开发，保留了 Delegate、Fusion 等进阶能力。本仓库的 Git 版本与上游 npm 包分别发布，安装时请使用下面的仓库地址。

## 安装

需要 Node.js **22.19.0 或更新版本**。包声明支持的 Pi 版本范围见 [package.json](package.json)。鼠标滚轮还需要宿主 Pi 提供鼠标事件，并在支持鼠标的全屏 TUI 中运行；键盘操作不依赖鼠标支持。

安装已发布的 Git 版本：

```bash
pi install git:github.com/CrossStar/pi-background-tasks@v2.7.1
```

跟随本仓库主分支，或只安装到当前项目：

```bash
pi install git:github.com/CrossStar/pi-background-tasks@main
pi install git:github.com/CrossStar/pi-background-tasks@main -l
```

开发本地代码时，在仓库目录执行：

```bash
npm ci
pi install .
```

本地路径安装直接读取磁盘文件。修改扩展后，在 Pi 中执行 `/reload` 加载改动。固定 tag 安装不会自动获得主分支上的新功能。

## 从一个后台命令开始

在 Pi 中输入：

```text
/bg --name "Python 脚本" python -u train.py
```

命令返回任务 ID 和日志路径后，可以继续对话。`python -u` 用于及时输出日志；程序自身的缓冲仍会影响实时显示。

打开监控台：

```text
/tasks
```

也可以按 **Shift+Down**，或使用 `/bg-tasks`。需要查看指定任务时，使用 `/tasks <完整任务 ID>`。

不用交互界面也能管理任务：

```text
/jobs
/logs <任务 ID> 20000
/kill <任务 ID>
```

`/bg` 默认发送完成通知，但不自动唤醒模型继续对话。模型调用 `bg_run` 时默认同时开启完成通知和后续唤醒，例如：

```json
{
  "name": "运行测试",
  "command": "npm test",
  "isAgent": false,
  "timeoutSeconds": 600
}
```

`isAgent: false` 表示普通 shell 命令。任务运行时不需要反复查询状态；收到完成通知后再按需查看日志。

## 任务监控台

宽终端采用左右分栏：左侧选择任务，右侧预览日志；窄终端自动改为上下排列。界面提供：

- 运行中、全部、失败三种筛选，切换或列表重排时保持选中的任务。
- 状态、耗时、PID、退出码、错误摘要和最近输出时间，最近输出最小以秒显示。
- 自动跟随日志；向上滚动暂停跟随，并提示新增行数，回到底部或按 `f` 恢复跟随。
- 分块搜索完整日志，能找到最近 128 KiB 预览范围之外的内容。
- 完整命令换行查看、分页、原样复制，以及用默认应用打开完整日志文件。
- 支持 `tqdm` 这类单行进度条的回车覆盖刷新；多行光标移动尚未实现完整终端仿真。

日志区域支持鼠标滚轮：鼠标悬停在预览或详情的日志正文上即可滚动，不会改变左侧选中的任务。在未提供鼠标事件的 Pi 版本或终端模式下，请使用方向键和翻页键。

| 按键 | 操作 |
| --- | --- |
| `↑` / `↓` | 在列表中选择任务；在详情中滚动日志 |
| `1` / `2` / `3` | 运行中 / 全部 / 失败 |
| `Enter` / `→` | 打开选中任务详情 |
| `←` | 从详情返回列表 |
| `PgUp` / `PgDn` | 翻页 |
| `/` | 输入搜索词，按 Enter 搜索 |
| `n` / `N` | 下一处 / 上一处匹配，不自动绕回 |
| `f` | 恢复日志跟随 |
| `v` | 查看完整命令；支持 Home/End 跳到首尾 |
| `y` / `p` | 复制完整命令 / 日志绝对路径 |
| `o` | 用系统默认应用打开完整日志 |
| `k` | 停止选中的运行中任务 |
| `a` | 停止全部运行中任务，需要再次按键确认 |
| `R` | 重新运行普通 shell 任务 |
| `c` | 显示日志路径 |
| `Esc` / `q` | 关闭监控台；在完整命令页中返回上一层 |

搜索按字面量区分大小写，不使用正则表达式。显示中的省略只影响预览，完整日志仍保留在文件中。仅预览任务不会清除未读徽标；明确打开详情或执行 `/bg-clear` 才会标记已读。

## `/reload` 后任务为什么还在

任务由同一个 Pi 进程中的共享 registry 托管。`/reload` 时旧扩展解除界面和通知绑定，新扩展取得同一个 registry 并重新绑定，因此子进程、任务 ID、日志流和停止能力都能延续。交接间隙完成的任务会在重新绑定后补发通知。

这支持的是**同一进程内的扩展热重载**。Pi 退出、崩溃或重启后，不会自动接管旧进程；正常退出以及新建、切换或派生会话会清理运行中任务。尚未注册为托管任务的 Fusion 预检会在 reload 时取消。

## 进阶能力

这些功能与普通 shell 任务共用任务管理入口，但不是运行后台命令的必需条件。

| 功能 | 用途 |
| --- | --- |
| `bg_delegate` | 启动一个固定模型路由的只读子 Pi，携带当前对话的筛选上下文进行调查 |
| `bg_result` | 校验并读取 Delegate / Fusion 的结果；运行中返回未就绪状态 |
| `bg_run_pi_attested` | 执行一个结构化子 Pi 任务，生成本地报告和校验记录 |
| `fusion_reason` | 多模型推理与综合，无工具调用 |
| `fusion_investigate` | 只读调查仓库 |
| `fusion_research` | 根据明确提供的公开 URL 获取资料并综合，不是网页搜索 |
| `fusion_validate` | 对已完成的改动进行只读辅助审查，不代替测试 |

`/fusion` 是推理流程的交互入口，`/fusion-models` 用于选择模型。Fusion 通常由三个候选、一个盲评和一个综合步骤组成，评估修复可能增加一次调用。Delegate / Fusion 不会静默替换指定模型；结果读取包含完整性校验。

Agent、Delegate 和 Fusion 任务只在详情中显示实际报告的模型遥测。普通 shell 任务不显示这些信息，命令自身打印的 stdout/stderr 始终保留。

包还包含 Anthropic 订阅归属与缓存处理扩展，安装时会全局加载；相关行为见 [Anthropic 子系统说明](docs/subsystems/anthropic-attribution.md)。

## 平台与运行边界

- Windows 默认使用 `cmd.exe`；POSIX 使用配置的 shell。命令语法应与实际平台一致，Windows 不会自动把 Bash 写法转换为 cmd。
- Windows 可通过 `PI_BG_SHELL=bash` 和 `PI_BG_SHELL_PATH` 显式选择 Bash；具体配置见 [配置文档](docs/operations/configuration.md)。
- 后台命令以当前用户权限执行，并非沙箱；程序调用网络或服务的行为由该命令决定。
- 日志和 metadata 位于项目的 `.pi/tasks/<session-id>-<pid>/`，Delegate / Fusion 另有自己的产物目录。
- 普通日志输出与终态 metadata 的持久化保证不同；完整约定见 [后台任务运行时](docs/subsystems/background-task-runtime.md)。
- 本地 attestation 是同用户可写的记录，不是对机器或提供方可信性的密码学证明。

## 开发与验证

```bash
npm ci
npm run typecheck
npm test
npm run test:component
npm run docs:generate
npm run docs:verify
npm run pack:dry-run
```

Linux/macOS 上还可以执行完整 Pi 兼容性验证；Windows 开发时可使用 WSL：

```bash
npm run test:compat
npm run test:agent-loop
npm run test:pty
# 需要 pnpm 11.18.0
npm run test:pnpm-pack
```

PTY 测试是否实际执行取决于宿主的交互输入能力；跳过不能视为交互验收通过。更多覆盖范围见 [TESTING.md](TESTING.md) 和 [TEST_PLAN.md](TEST_PLAN.md)。Git 发版说明见 [PUBLISHING.md](PUBLISHING.md)。

## 文档导航

- [完整文档索引](docs/INDEX.md)
- [任务监控台](docs/commands/task-manager.md)
- [通知与后续唤醒](docs/concepts/completion-delivery.md)
- [工作流选择](docs/choose-a-workflow.md)
- [EventBus 扩展集成](docs/api/eventbus-v1.md)
- [配置](docs/operations/configuration.md)与[故障排查](docs/operations/troubleshooting.md)

## 自动生成的包信息

以下信息由文档生成器从源码和包配置更新。

<!-- pi-docs:begin name="readme-package-facts" generator="scripts/docs/generate.mjs" -->
| 项目 | 内容 |
| --- | --- |
| 包名 | `pi-background-tasks` |
| 版本 | `2.7.1` |
| Node 版本要求 | `>=22.19.0` |
| Pi 扩展入口 | `./extensions/anthropic-attribution.ts`, `./extensions/background-tasks.ts` |
| 项目图标 | [logo.png](logo.png) |
<!-- pi-docs:end name="readme-package-facts" -->

<!-- pi-docs:begin name="readme-public-surfaces" generator="scripts/docs/generate.mjs" -->
| 接口类型 | 数量 |
| --- | --- |
| 命令 | 11 |
| 工具 | 11 |
| 快捷键 | 2 |
| 消息渲染器 | 2 |
| 事件接口 | 1 |
| 工作流 | 4 |

公开命令：`/bg`, `/bg-clear`, `/bg-tasks`, `/bg-update`, `/claude-cache`, `/fusion`, `/fusion-models`, `/jobs`, `/kill`, `/logs`, `/tasks`。

公开工具：`bg_delegate`, `bg_kill`, `bg_logs`, `bg_result`, `bg_run`, `bg_run_pi_attested`, `bg_status`, `fusion_investigate`, `fusion_reason`, `fusion_research`, `fusion_validate`。

完整接口与源码归属见 [docs/INDEX.md](docs/INDEX.md)。
<!-- pi-docs:end name="readme-public-surfaces" -->

## 来源与许可

本仓库基于上游项目继续维护，新增了 reload 任务交接、日志监控台、命令查看和进度条显示等改进。保留原项目的 ISC 许可与第三方声明，详见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
