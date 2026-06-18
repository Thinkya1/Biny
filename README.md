# Biny

Biny is a TypeScript CLI coding agent. First version only supports a simple CLI loop, local file tools, command execution with confirmation, git diff display, and JSONL session recording.

## Install

```bash
pnpm install
```

## Run in development

```bash
pnpm dev -- init
pnpm dev -- doctor
pnpm dev -- run "这个项目是做什么的？"
pnpm dev -- chat
```

## Link the `biny` command

```bash
pnpm build
pnpm link --global
biny doctor
```

## Examples

```bash
biny run "读取 package.json 并解释"
biny run "修改 src/index.ts，把 hello 改成 hello agent"
biny run "运行 pnpm typecheck 并分析错误"
```

By default the mock provider is used, so no API key is required.
