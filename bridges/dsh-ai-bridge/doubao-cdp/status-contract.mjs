#!/usr/bin/env node
/**
 * status-contract.mjs —— 派发时给豆包的**状态回报契约**（单一事实来源）。
 *
 * 为什么要单独一个模块：这段文字以前只写在 skill 的模板里，靠人手复制；
 * 一旦派发器自己拼指令，两处措辞就会漂移。放在这里，派发器与文档引用同一份。
 *
 * 措辞要点（都是踩过坑换来的）：
 *   - 「收到任务后、动手之前」先发 started —— 不是「干完再补」；
 *   - 明确写「只回复『已完成』不算数」—— 客户端会编造工具调用；
 *   - 明确写「做不到就直说」—— 对话模式没有 shell，硬撑只会让人以为在跑。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** status.mjs 的绝对路径（给豆包执行的命令里要用绝对路径）。 */
export const STATUS_SCRIPT = join(HERE, 'status.mjs')

/** 把命令包成豆包可直接粘贴执行的样子。 */
function cmd(script, args) {
  return `node "${script}" ${args}`
}

/**
 * 生成状态回报契约。
 * @param job 关联标识（派发标记或任务 id）
 * @param script 覆盖 status.mjs 路径（测试用）
 */
export function buildStatusDirective({ job, script = STATUS_SCRIPT } = {}) {
  if (typeof job !== 'string' || job.length === 0) throw new Error('buildStatusDirective needs a job id')
  return [
    '【状态回报｜必须做】你收到这条任务后、动手之前，先执行下面第一条命令，然后再开始干活：',
    `1) 工作开始（动手前）：${cmd(script, `start --job ${job}`)}`,
    '2) 干完之后：' + cmd(script, `done --job ${job} --message "结果摘要"`),
    '3) 如果失败：' + cmd(script, `fail --job ${job} --message "错误摘要"`),
    '4) 需要我确认才继续：' + cmd(script, `need-input --job ${job} --message "卡在哪"`),
    '5) 想报进度（可选）：' + cmd(script, `progress --job ${job} --percent 50 --step "步骤名"`),
    '',
    `只回复"我开始了"或"已完成"**不算数**——只有上面这些命令真的执行了、状态文件里出现了事件，才算回报。`,
    '如果这个模式没有 PowerShell（比如对话模式），就直接说做不到，不要假装执行过。',
  ].join('\n')
}

/** 契约里出现的状态，供调用方核对。 */
export const CONTRACT_STATES = ['started', 'done', 'failed', 'need_input', 'progress']
