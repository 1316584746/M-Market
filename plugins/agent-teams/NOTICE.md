AgentTeams 的产品模型移植自 [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)（MIT，作者 Relakkes）：
队长 + 持久成员、带依赖的任务、attempt / attemptId 尝试代次、信箱、先批准后运行、14 个 agent_teams_* 协调工具的名字和语义，以及质量门（任务类型与合同、完成证据、范围审计、评审不过后自动修复 + 复审、升级给队长、目标覆盖与可交付判定）。
代码是为 M-Harness 的插件宿主从零重新实现的，没有复制上游源码。

AgentTeams is a port of the product model of NanmiCoder/dsh-agent-teams (MIT): captain + durable members, dependency-aware tasks,
attempt generations, mailboxes, plan-then-approve, the names and semantics of the 14 agent_teams_* tools, and the quality gates
(task kinds and contracts, completion evidence, scope audit, automatic repair + re-review loop, escalation, goal coverage and deliverable verdict).
The code is a from-scratch reimplementation for the M-Harness plugin host; no upstream source was copied.

和上游不同的地方（M-Harness 的插件宿主没有对应能力，且不改内核）：
- 成员不是宿主的子 Agent，而是插件自己跑的「模型 → 工具」循环，直接调用 M-Harness 配置里 type 为 openai-compat 或 anthropic 的提供方（cursor-sdk / 命令行 Agent 不行）；key 只用于请求，不回显到界面。
- 成员的读文件、写文件、执行命令由插件自己实现，不经过 M-Harness 的审批：读限工作区内；写和执行要在页面里确认，团队可以「全部允许」；成员可设为只读。
- 聊天里没有内嵌团队卡片，也没有系统提示词注入：团队协作信息写在工具结果里，队长靠 agent_teams_status（可带 wait_seconds）拿成员结果。
- 成员的 token 用量只记在团队文件里，不写进 M-Harness 的 trace。
- 质量门的范围检查发生在「写入时」：插件自己持有 write_file，所以越界写入会在落盘前被拒绝；上游是事后审计。代价是 run_command 里发生的文件改动插件看不见，没法审计（只能靠成员在 changed_paths 里如实交代）。
- 质量门的「自动创建修复任务 + 复审」由插件在评审任务失败的那一刻直接写进任务表，不依赖队长再发一轮指令；超过 max_repair_attempts 才升级给队长。
- 没有上游的成员模型第二选择（fallback）、/agent-teams 斜杠命令和命名多角色 profile。

Differences from upstream (the M-Harness plugin host has no matching capability and the kernel is not modified):
- Members are not host sub-agents but a model → tool loop run by the plugin, calling providers of type openai-compat or anthropic from the M-Harness config (cursor-sdk / CLI agents are not supported). Keys are only used for requests.
- File read / write / command execution are implemented by the plugin and bypass M-Harness approvals: reads are limited to the workspace; writes and commands are confirmed in the panel (a per-team "allow all" exists); members can be read-only.
- Scope is enforced at write time (the plugin owns write_file), not audited afterwards. Changes made through run_command cannot be audited.
- No fallback model, no /agent-teams slash command, no named multi-role profiles.
